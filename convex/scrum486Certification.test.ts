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
import {
  insertReceiptBank, seedFinancedDealership, newApplication, refusalDataOf,
} from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectRetiredDealMode } from "../test-utils/retiredDealMode";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
// Setup only: the pilot-dark receipt-application doors have no public caller (see addActiveCustomerCredit).
import { reservePendingInvoiceReceipt } from "./accounting/invoiceReceiptReservation";
import { activatePendingInvoiceReceipt } from "./accounting/invoiceReceiptActivation";

// SCRUM-869#c23881: the supplier-payable rewrite is refused in the shipped pilot; these historical cases
// keep exercising the deferred mechanics. The shipped-state refusal is convex/supplierObligationCorrections.test.ts.
vi.mock("./utils/supplierSettlementContainment", async (importOriginal) =>
  (await import("../test-utils/supplierSettlementSwitches")).openSupplierSettlementDoors(
    await importOriginal<typeof import("./utils/supplierSettlementContainment")>()
  )
);
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

/**
 * Guard-flip handles for the SCRUM-760 mutation attacks. Both default to "no
 * attack": every cell then runs against the shipped guards, exactly as
 * production does. Only the dedicated attack tests set one, and each resets it
 * in a `finally`.
 */
const guardAttack = vi.hoisted(() => ({
  payoutSwitchDisabled: undefined as boolean | undefined,
  skipPendingAvailabilityGuard: false,
}));
vi.mock("./utils/customerCreditPayoutContainment", async (importOriginal) => {
  const original = await importOriginal<typeof import("./utils/customerCreditPayoutContainment")>();
  return {
    ...original,
    // No override: the shipped `true as const` value. The attack test substitutes `false`.
    assertCustomerCreditPayoutAllowed: (disabled?: boolean) =>
      original.assertCustomerCreditPayoutAllowed(
        disabled ?? guardAttack.payoutSwitchDisabled ?? original.CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED
      ),
  };
});
vi.mock("./utils/depositCancellationPending", async (importOriginal) => {
  const original = await importOriginal<typeof import("./utils/depositCancellationPending")>();
  return {
    ...original,
    assertNoPendingBeforeAvailable: (...args: Parameters<typeof original.assertNoPendingBeforeAvailable>) =>
      guardAttack.skipPendingAvailabilityGuard ? Promise.resolve() : original.assertNoPendingBeforeAvailable(...args),
  };
});

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

/** SCRUM-802 (owner ruling, Option A): a cash sale completes only once its full price is held as deposit. */
const CASH_PRICE_MINOR = 12_500_000;

/** Pays the quote's full price (12,500) by deposit, the pilot procedure; returns the held deposit. */
async function payFullByDeposit(s: CashSeed, quoteId: Id<"quotes">, suffix: string) {
  return await s.owner.as.mutation(api.deposits.create, {
    orgId: s.orgId, quoteId, amount: 12_500, method: "CASH", idempotencyKey: `scrum486-full-deposit-${suffix}`,
  });
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

/** The full-price deposit receipt and its application to the invoice, as completion leaves them. */
function fullDepositRows(applicationStatus: "POSTED" | "REVERSED" = "POSTED"): JournalRow[] {
  return [
    { account: "1100", currency: "JOD", debit: CASH_PRICE_MINOR, credit: 0, entryStatus: "POSTED" },
    { account: "2100", currency: "JOD", debit: 0, credit: CASH_PRICE_MINOR, entryStatus: "POSTED" },
    { account: "2100", currency: "JOD", debit: CASH_PRICE_MINOR, credit: 0, entryStatus: applicationStatus },
    { account: "1200", currency: "JOD", debit: 0, credit: CASH_PRICE_MINOR, entryStatus: applicationStatus },
  ];
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
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER" as const, bankAccountId: await seedBank(s.t, s.orgId), paidAt,
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
    // SCRUM-54: the finance company's transfer names the physical bank it reached. Seeded
    // before the snapshot so the zero-write refusal checks below still compare like with like.
    const receiptBankAccountId = await insertReceiptBank(s);
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
      bankAccountId: receiptBankAccountId,
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

  async function ownedFinancedOpening(tag: string, tender: "BANK_TRANSFER" | "CHEQUE" = "BANK_TRANSFER") {
    const s = await seedFinancedDealership(tag, {
      modules: MODULES,
      ownerPerms: OWNER_PERMS,
      actors: {
        salesperson: ["view:sales", "edit:sales", "view:finance_applications", "create:finance_application"],
        // Roles that each lack ONE of the two permissions the finance cheque return requires.
        viewFinanceOnly: ["view:finance", "manage:finance", "view:finance_applications"],
        confirmOnly: ["confirm:finance_disbursement"],
      },
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
    await s.owner.as.mutation(
      api.applications.registerExpectedPayment,
      tender === "CHEQUE"
        ? {
            orgId: s.orgId, applicationId, method: "CHEQUE", expectedDate: Date.now(),
            chequeDetails: { bank: "Arab Bank", chequeNumber: `${tag}-chq` }, faceAmount: "12500",
          }
        : { orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now() }
    );
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
    // The victim's own bank: the foreign application must be refused before any bank is judged.
    const victimBank = await seedBank(s.t, s.orgId);
    const before = await dbSnapshot(s.t, Object.keys(schema.tables));

    await expect(other.owner.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: other.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: victimBank, paidAt: Date.now(),
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

  /**
   * An owned configured-financier deal whose 12,500,000 receipt was a CHEQUE that cleared into a named
   * bank (the reconciliation-target bank), plus the readers the finance-cheque return rows share.
   */
  async function clearedFinanceChequeDeal(tag: string) {
    const { s, applicationId } = await ownedFinancedOpening(tag, "CHEQUE");
    const bankAccountId = await insertReceiptBank(s);
    await s.t.run((ctx) => ctx.db.patch(bankAccountId, { isReconciliationTarget: true }));
    await s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000, idempotencyKey: `${tag}-receipt`, bankAccountId,
    });
    const chequesOf = () => s.t.run((ctx) => ctx.db.query("postDatedCheques")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId)).collect());
    const [cleared] = await chequesOf();
    expect(cleared.status).toBe("CLEARED");
    return {
      s, applicationId, bankAccountId, cleared, chequesOf,
      application: () => s.t.run((ctx) => ctx.db.get(applicationId)),
      financeReceivable: () => s.t.run((ctx) => ctx.db.query("receivableDocuments")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
          .eq("sourceType", "finance_application").eq("sourceId", applicationId)).unique()),
      bankBalance: async () =>
        (await s.owner.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId }))?.balanceMinor,
      snapshot: () => fullTables(s),
      returnArgs: (key: string) => ({
        orgId: s.orgId, applicationId, chequeId: cleared._id,
        returnReason: "Bank returned: insufficient funds", idempotencyKey: key,
      }),
    };
  }

  /** Names of the tables whose full contents differ between two snapshots. */
  function changedTables(before: Awaited<ReturnType<typeof dbSnapshot>>, after: Awaited<ReturnType<typeof dbSnapshot>>) {
    return Object.keys(before).filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table])).sort();
  }

  /** The eight literal journal lines once the receipt entry is reversed: sale rows, REVERSED receipt, POSTED inverse. */
  const REVERSED_RECEIPT_ROWS: JournalRow[] = [
    { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
    { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
    { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
    { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    { account: "1110", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "REVERSED" },
    { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "REVERSED" },
    { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
    { account: "1110", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
  ];
  /** Normal-sign trial balance before the financier paid: the receipt and its reversal net to nothing. */
  const PRE_RECEIPT_TRIAL_BALANCE = {
    "1210|JOD": 12_500_000,
    "1400|JOD": -10_000_000,
    "4100|JOD": 12_500_000,
    "5100|JOD": 10_000_000,
  };

  test("owned configured financier × CHEQUE tender × cleared cheque returned by the bank: the receipt is undone exactly", async () => {
    const d = await clearedFinanceChequeDeal("s486fcreturn");
    const { s, applicationId, cleared } = d;

    // Opening facts after the receipt: the financier paid 12,500,000 into the named bank.
    expect(await d.bankBalance()).toBe(12_500_000);
    expect((await d.financeReceivable())?.status).toBe("PAID");
    expect((await d.application())?.disbursedAmountMinor).toBe(12_500_000);
    expectLiteralRows(await journalRows(s), [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
    ]);
    const before = await d.snapshot();

    const returnArgs = d.returnArgs("s486fcreturn-return");
    const result = await s.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, returnArgs);
    expect(result).toMatchObject({
      chequeId: cleared._id, returnedDisbursementVersion: 1, nextDisbursementVersion: 2, reversal: "REVERSED",
    });

    // Ledger: the receipt entry is REVERSED and an exact inverse is POSTED; the sale rows are untouched.
    const afterRows = await journalRows(s);
    expectLiteralRows(afterRows, REVERSED_RECEIPT_ROWS);
    expectBalanced(afterRows);
    // Subledger and bank: the financier owes the full 12,500,000 again and the named bank is back to zero.
    expect(await d.bankBalance()).toBe(0);
    const reopened = await d.financeReceivable();
    expect(reopened).toMatchObject({ payerType: "FINANCE_COMPANY", originalAmountMinor: 12_500_000, status: "OPEN" });
    expect(await trialBalanceNormalBalance(s)).toEqual(PRE_RECEIPT_TRIAL_BALANCE);
    // Deal and cheque state: the deal stays CLOSED and expects the next receipt; the cheque is RETURNED.
    const application = await d.application();
    expect(application).toMatchObject({ status: "CLOSED", settlementStatus: "EXPECTED", disbursementVersion: 2 });
    expect(application?.disbursedAt).toBeUndefined();
    expect(application?.disbursedAmountMinor).toBeUndefined();
    expect((await d.chequesOf())[0]).toMatchObject({
      status: "RETURNED", returnedAfterClearing: true, disbursementVersion: 1, returnReason: "Bank returned: insufficient funds",
    });
    const payments = await s.t.run((ctx) => ctx.db.query("canonicalPayments").collect());
    expect(payments.filter((payment) => payment.orgId === s.orgId).map((payment) => payment.status)).toEqual(["VOIDED"]);
    const allocations = await s.t.run((ctx) => ctx.db.query("paymentAllocations").collect());
    expect(allocations.filter((allocation) => allocation.receivableDocumentId === reopened?._id)
      .map((allocation) => allocation.status)).not.toContain("ACTIVE");
    const audit = await s.t.run(async (ctx) => (await ctx.db.query("financialAuditLog").collect())
      .filter((row) => row.orgId === s.orgId && row.actionType === "RETURN_FINANCE_DISBURSEMENT_CHEQUE"));
    expect(audit).toHaveLength(1);
    expect(audit[0].resourceId).toBe(applicationId);

    // Full-table snapshot: only the tables a disbursement return owns changed; the sale, customer,
    // vehicle, commission, forward and every other table are identical to before the return.
    const after = await d.snapshot();
    expect(changedTables(before, after)).toEqual([
      "accountBalanceSnapshots", "accountingEvents", "bankBalanceAggregateItems", "bankBalanceGrossShards",
      "canonicalPayments", "commandIdempotency", "financeApplications", "financialAuditLog", "journalEntries",
      "journalLines", "paymentAllocations", "postDatedCheques", "receivableDocuments",
    ]);

    // Replay: the same key and command is one effect.
    const replay = await s.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, returnArgs);
    expect(replay).toEqual(result);
    expect(await d.snapshot()).toEqual(after);
    expect(await d.bankBalance()).toBe(0);
  }, 20_000);

  test("owned configured financier × CHEQUE tender × cleared cheque return: a role missing either required permission is refused with FORBIDDEN and nothing changes", async () => {
    const d = await clearedFinanceChequeDeal("s486fcperm");
    // Each refusal names the permission(s) that role actually lacks.
    const roles: Array<[typeof d.s.actors.salesperson.as, RegExp]> = [
      [d.s.actors.salesperson.as, /Missing required permissions:.*confirm:finance_disbursement.*view:finance|Missing required permissions:.*view:finance.*confirm:finance_disbursement/s],
      [d.s.actors.viewFinanceOnly.as, /Missing required permissions: confirm:finance_disbursement/],
      [d.s.actors.confirmOnly.as, /Missing required permissions: view:finance/],
    ];
    let n = 0;
    for (const [as, message] of roles) {
      await expectRefusedAndUnchanged(
        d.s,
        () => as.mutation(api.applications.returnFinanceDisbursementCheque, d.returnArgs(`s486fcperm-${n++}`)),
        { code: "FORBIDDEN", message },
      );
    }
    expect((await d.chequesOf())[0].status).toBe("CLEARED");
    expect(await d.bankBalance()).toBe(12_500_000);
  }, 30_000);

  test("owned configured financier × CHEQUE tender × cleared cheque return: foreign tenant legs (foreign caller, foreign cheque id, foreign application id) are each refused and nothing changes", async () => {
    const d = await clearedFinanceChequeDeal("s486fcforeign");
    const other = await authorizedOtherTenant(d.s, "s486fcforeign");
    // Copies of this tenant's rows that belong to the other tenant (same table, other orgId).
    const foreign = await d.s.t.run(async (ctx) => {
      const { _id: _a, _creationTime: _ac, ...applicationRow } = (await ctx.db.get(d.applicationId))!;
      const { _id: _c, _creationTime: _cc, ...chequeRow } = (await ctx.db.get(d.cleared._id))!;
      return {
        applicationId: await ctx.db.insert("financeApplications", { ...applicationRow, orgId: other.orgId }),
        chequeId: await ctx.db.insert("postDatedCheques", { ...chequeRow, orgId: other.orgId }),
      };
    });
    const asThisTenant = d.s.owner.as;
    type ReturnArgs = ReturnType<typeof d.returnArgs>;
    const call = (as: { mutation: typeof asThisTenant.mutation }, args: Record<string, unknown>) => () =>
      as.mutation(api.applications.returnFinanceDisbursementCheque, args as ReturnArgs);

    // (1) The other tenant's owner names their own org with this org's application and cheque ids.
    await expectRefusedAndUnchanged(
      d.s,
      call(other.owner, { ...d.returnArgs("s486fcforeign-caller"), orgId: other.orgId }),
      { code: "FINANCE_RETURN_NOT_FOUND" },
    );
    // (2) This org's application with a cheque id that belongs to the other org.
    await expectRefusedAndUnchanged(
      d.s,
      call(asThisTenant, { ...d.returnArgs("s486fcforeign-cheque"), chequeId: foreign.chequeId }),
      { code: "FINANCE_RETURN_NOT_FOUND" },
    );
    // (3) This org's cheque with an application id that belongs to the other org.
    await expectRefusedAndUnchanged(
      d.s,
      call(asThisTenant, { ...d.returnArgs("s486fcforeign-application"), applicationId: foreign.applicationId }),
      { code: "FINANCE_RETURN_NOT_FOUND" },
    );
    // (4) The other tenant's owner names THIS org: they hold no membership there, so tenant authorization
    // refuses before any row is read.
    await expectRefusedAndUnchanged(
      d.s,
      call(other.owner, d.returnArgs("s486fcforeign-member")),
      { code: "UNAUTHORIZED" },
    );
    expect((await d.chequesOf())[0].status).toBe("CLEARED");
    expect(await d.bankBalance()).toBe(12_500_000);
  }, 30_000);

  /** Stored snapshots after the receipt and before the return: sale (1210 Dr, 4100 Cr, 5100 Dr, 1400 Cr) and receipt (1110 Dr, 1210 Cr). */
  const SNAPSHOT_BEFORE_RETURN = {
    "1110|JOD": { debit: 12_500_000, credit: 0 },
    "1210|JOD": { debit: 12_500_000, credit: 12_500_000 },
    "1400|JOD": { debit: 0, credit: 10_000_000 },
    "4100|JOD": { debit: 0, credit: 12_500_000 },
    "5100|JOD": { debit: 10_000_000, credit: 0 },
  };
  /** After the inverse posts: 1110 gains a 12,500,000 credit and 1210 a 12,500,000 debit; nothing else moves. */
  const SNAPSHOT_AFTER_REVERSAL = {
    ...SNAPSHOT_BEFORE_RETURN,
    "1110|JOD": { debit: 12_500_000, credit: 12_500_000 },
    "1210|JOD": { debit: 25_000_000, credit: 12_500_000 },
  };

  test("owned configured financier × CHEQUE tender × cleared cheque return with no open period: the return succeeds, the reversal is DEFERRED, then posts exactly once a period opens", async () => {
    const d = await clearedFinanceChequeDeal("s486fcperiod");
    const { s, applicationId, cleared } = d;
    // Periods move only through the public accounting-period mutations (oracle gate contract item 1).
    const ownPeriodIds = async () => (await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId })).map((p) => p._id);
    const [periodId] = await ownPeriodIds();
    expect(await ownPeriodIds()).toHaveLength(1);
    // Stored account snapshots, summed over shards as the trial balance reads them, are asserted at each stage.
    expect(await storedPeriodSnapshot(s, periodId)).toEqual(SNAPSHOT_BEFORE_RETURN);
    for (const periodId of await ownPeriodIds()) {
      const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId });
      await s.owner.as.mutation(api.accountingPeriods.close, { orgId: s.orgId, periodId, acknowledgedWarnings: checklist.warnings });
    }
    expect(await s.owner.as.query(api.accountingPeriods.currentOpenPeriod, { orgId: s.orgId })).toBeNull();
    const rowsBefore = await journalRows(s);
    // With every period closed a role without the authority is still refused FORBIDDEN, writing nothing.
    await expectRefusedAndUnchanged(
      s,
      () => s.actors.salesperson.as.mutation(
        api.applications.returnFinanceDisbursementCheque, d.returnArgs("s486fcperiod-forbidden")),
      { code: "FORBIDDEN" },
    );
    const before = await d.snapshot();

    const result = await s.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, d.returnArgs("s486fcperiod-return"));
    expect(result).toMatchObject({
      chequeId: cleared._id, reversal: "DEFERRED", returnedDisbursementVersion: 1, nextDisbursementVersion: 2,
    });

    // Deferred state: the closed period is not written into (the ledger still shows the receipt), but the
    // business state moves now: payment VOIDED, debt reopened, deal expecting the next receipt, cheque RETURNED.
    // The deferred reversal wrote nothing into the account snapshots.
    expect(await storedPeriodSnapshot(s, periodId)).toEqual(SNAPSHOT_BEFORE_RETURN);
    expect(await journalRows(s)).toEqual(rowsBefore);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1110|JOD": 12_500_000, "1400|JOD": -10_000_000, "4100|JOD": -12_500_000, "5100|JOD": 10_000_000,
    });
    const payments = await s.t.run((ctx) => ctx.db.query("canonicalPayments").collect());
    expect(payments.filter((payment) => payment.orgId === s.orgId).map((payment) => payment.status)).toEqual(["VOIDED"]);
    const reopened = await d.financeReceivable();
    expect(reopened).toMatchObject({ payerType: "FINANCE_COMPANY", originalAmountMinor: 12_500_000, status: "OPEN" });
    const allocations = await s.t.run((ctx) => ctx.db.query("paymentAllocations").collect());
    expect(allocations.filter((allocation) => allocation.receivableDocumentId === reopened?._id)
      .map((allocation) => allocation.status)).not.toContain("ACTIVE");
    const application = await d.application();
    expect(application).toMatchObject({ status: "CLOSED", settlementStatus: "EXPECTED", disbursementVersion: 2 });
    expect(application?.disbursedAt).toBeUndefined();
    expect((await d.chequesOf())[0]).toMatchObject({ status: "RETURNED", returnedAfterClearing: true, disbursementVersion: 1 });
    const queued = () => s.t.run(async (ctx) => (await ctx.db.query("pendingAccountingEvents").collect())
      .filter((row) => row.orgId === s.orgId && row.kind === "REVERSE"));
    expect((await queued()).map((row) => row.status)).toEqual(["PENDING"]);
    expect(changedTables(before, await d.snapshot())).toEqual([
      "canonicalPayments", "commandIdempotency", "financeApplications", "financialAuditLog",
      "paymentAllocations", "pendingAccountingEvents", "postDatedCheques", "receivableDocuments",
    ]);
    // A replacement confirmation from the screen that observed version 1 is refused as stale.
    const stale = await refusalDataOf(s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000, idempotencyKey: "s486fcperiod-stale",
      bankAccountId: d.bankAccountId, expectedDisbursementVersion: 1,
    }));
    expect(stale?.code).toBe("FINANCE_CONFIRM_STALE_REQUEST");

    // Reopening a period through the public mutation wakes the outbox: the exact inverse posts once, and a
    // second drain finds nothing left to post (exactly once, not at-least-once).
    const settle = async () => {
      for (let pass = 0; pass < 10; pass += 1) {
        await s.t.finishAllScheduledFunctions(vi.runAllTimers);
        const inFlight = (await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()))
          .filter((f) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
        if (inFlight === 0) break;
      }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      for (const periodId of await ownPeriodIds()) {
        await s.owner.as.mutation(api.accountingPeriods.reopen, {
          orgId: s.orgId, periodId, reason: "Certification: the deferred cheque-return reversal must post",
        });
      }
      await settle();
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      await settle();
      const afterFirstDrains = await journalRows(s);
      const eventsOf = () => s.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect())
        .filter((row) => row.orgId === s.orgId));
      const outboxOf = () => s.t.run(async (ctx) => (await ctx.db.query("pendingAccountingEvents").collect())
        .filter((row) => row.orgId === s.orgId));
      const eventsAfterFirst = await eventsOf();
      const outboxAfterFirst = await outboxOf();
      const snapshotAfterFirst = await storedPeriodSnapshot(s, periodId);
      expect(snapshotAfterFirst).toEqual(SNAPSHOT_AFTER_REVERSAL);
      // Whole stored documents (ids, shards, timestamps, running totals), not a projection.
      const snapshotRowsOf = () => s.t.run(async (ctx) => (await ctx.db.query("accountBalanceSnapshots").collect())
        .filter((row) => row.orgId === s.orgId && row.periodId === periodId));
      const snapshotRowsAfterFirst = await snapshotRowsOf();
      expect(snapshotRowsAfterFirst.length).toBeGreaterThan(0);
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      await settle();
      // Replay: nothing is posted again, so journal, events, the whole outbox rows and the snapshots are identical.
      expect(await journalRows(s)).toEqual(afterFirstDrains);
      expect(await eventsOf()).toEqual(eventsAfterFirst);
      expect(await outboxOf()).toEqual(outboxAfterFirst);
      expect(await storedPeriodSnapshot(s, periodId)).toEqual(SNAPSHOT_AFTER_REVERSAL);
      expect(await snapshotRowsOf()).toEqual(snapshotRowsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
    const afterRows = await journalRows(s);
    expectLiteralRows(afterRows, REVERSED_RECEIPT_ROWS);
    expectBalanced(afterRows);
    expect(await trialBalanceNormalBalance(s)).toEqual(PRE_RECEIPT_TRIAL_BALANCE);
    expect(await d.bankBalance()).toBe(0);
    expect((await queued()).map((row) => row.status)).toEqual(["POSTED"]);
  }, 30_000);

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

  test("SOURCED through dealership × full financier bank receipt: settles financier AR without changing supplier liability or agency margin", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486sourcedreceipt", "THROUGH_DEALERSHIP");
    const bankAccountId = await seedBank(s.t, s.orgId);
    const beforeReceipt = await journalRows(s);
    // SCRUM-407 c21031 and the G8 worked example: the financier transfers the
    // full approved 12,500 JOD. Supplier entitlement 10,000 and margin 2,500
    // were recognized at finalization; receiving cash earns no further revenue.
    expectLiteralRows(beforeReceipt, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    const receiptArgs = {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000,
      bankAccountId, idempotencyKey: "s486-sourced-through-full-receipt",
    };
    await s.owner.as.mutation(api.applications.confirmDisbursement, receiptArgs);
    const afterReceipt = await journalRows(s);
    expectAdditionalRows(beforeReceipt, afterReceipt, [
      { account: "1110", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(afterReceipt);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1110|JOD": 12_500_000, "2400|JOD": 10_000_000, "4170|JOD": 2_500_000,
    });
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(application).toMatchObject({ status: "CLOSED", disbursedAmountMinor: 12_500_000 });
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    expect(await s.t.run((ctx) => ctx.db.query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).unique()))
      .toMatchObject({ amountDue: 10_000, currency: "JOD", status: "PENDING" });
    expect(await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", applicationId)).unique()))
      .toMatchObject({ payerType: "FINANCE_COMPANY", originalAmountMinor: 12_500_000, status: "PAID" });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 2_500_000, totalCogs: 0, grossProfit: 2_500_000, netIncome: 2_500_000,
    });
    const afterReceiptSnapshot = await dbSnapshot(s.t, Object.keys(schema.tables));
    await s.owner.as.mutation(api.applications.confirmDisbursement, receiptArgs);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterReceiptSnapshot);
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
    const bankAccountId = await seedBank(s.t, s.orgId);
    const receiptArgs = {
      orgId: s.orgId, receivableId: claim!._id, amount: 2_500,
      receiptMethod: "BANK_TRANSFER" as const,
      bankAccountId,
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
    const bankAccountId = await seedBank(s.t, s.orgId);
    const firstArgs = {
      orgId: s.orgId, receivableId: claim!._id, amount: 1_000,
      receiptMethod: "BANK_TRANSFER" as const,
      bankAccountId,
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

  test("owned CASH × full price held as deposit: sale recognizes literal receivable, revenue, COGS and inventory, and the deposit settles the receivable", async () => {
    const { s, quoteId } = await cashQuote("s486cashnone");
    await payFullByDeposit(s, quoteId, "owned-full");
    const saleId = await completeCashSale(s, quoteId, "no-deposit");

    const saleStatus = await s.t.run(async (ctx) => (await ctx.db.get(saleId))?.status);
    const rows = await journalRows(s);
    expect(saleStatus).toBe("COMPLETED");
    expectLiteralRows(rows, [
      ...fullDepositRows(),
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    // The receivable the sale opened is settled to zero by the deposit; the cash is the customer's payment.
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 12_500_000,
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

  test("owned CASH × full deposit × cancellation: sale journals reverse and the customer's deposit returns to held", async () => {
    const { s, quoteId } = await cashQuote("s486ownedcancel");
    const depositId = await payFullByDeposit(s, quoteId, "owned-cancel");
    const saleId = await completeCashSale(s, quoteId, "owned-no-deposit-cancel");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 12_500_000,
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
    // The deposit application is reversed with the sale; the receipt itself stays posted and the deposit is held again.
    const depositReversalRows: JournalRow[] = [
      { account: "2100", currency: "JOD", debit: 0, credit: CASH_PRICE_MINOR, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: CASH_PRICE_MINOR, credit: 0, entryStatus: "POSTED" },
    ];
    expectLiteralRows(rows, [...originalRows, ...reversalRows, ...fullDepositRows("REVERSED"), ...depositReversalRows]);
    expectBalanced(rows);
    expect(await s.t.run((ctx) => ctx.db.get(depositId))).toMatchObject({ status: "HELD", holdActive: true, amountMinor: CASH_PRICE_MINOR });
    expect(netByAccount(rows)).toEqual({ "1100|JOD": CASH_PRICE_MINOR, "2100|JOD": -CASH_PRICE_MINOR });
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": CASH_PRICE_MINOR, "2100|JOD": CASH_PRICE_MINOR });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test("SOURCED CASH × full price held as deposit: agent margin only, deposit-settled customer AR and supplier liability", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedcash");
    await payFullByDeposit(s, quoteId, "sourced-full");
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
      ...fullDepositRows(),
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 12_500_000,
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

  test("SOURCED CASH × full deposit × cancellation: agency sale and supplier claim reverse and the deposit returns to held", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedcancel");
    const depositId = await payFullByDeposit(s, quoteId, "sourced-cancel");
    const saleId = await completeCashSale(s, quoteId, "sourced-cancel");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 12_500_000,
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
      ...fullDepositRows("REVERSED"),
      { account: "2100", currency: "JOD", debit: 0, credit: CASH_PRICE_MINOR, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: CASH_PRICE_MINOR, credit: 0, entryStatus: "POSTED" },
    ]);
    expect(await s.t.run((ctx) => ctx.db.get(depositId))).toMatchObject({ status: "HELD", holdActive: true, amountMinor: CASH_PRICE_MINOR });
    expect(netByAccount(rows)).toEqual({ "1100|JOD": CASH_PRICE_MINOR, "2100|JOD": -CASH_PRICE_MINOR });
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": CASH_PRICE_MINOR, "2100|JOD": CASH_PRICE_MINOR });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test.each([
    {
      route: "owned",
      quote: cashQuote,
      expectedNet: {
        "1100|JOD": 12_500_000,
        "1400|JOD": -10_000_000,
        "4100|JOD": -12_500_000,
        "5100|JOD": 10_000_000,
      },
    },
    {
      route: "sourced",
      quote: sourcedCashQuote,
      expectedNet: {
        "1100|JOD": 12_500_000,
        "2400|JOD": -10_000_000,
        "4170|JOD": -2_500_000,
      },
    },
  ])("$route CASH × completed sale: salesperson with edit:sales cannot reverse money", async ({ route, quote, expectedNet }) => {
    const { s, quoteId } = await quote(`s486${route}sellerdeny`);
    await payFullByDeposit(s, quoteId, `${route}-seller-deny`);
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

  test("SOURCED CASH × full price applied from deposit: customer AR is settled, supplier entitlement stays whole", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedapplied", 12_500);
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 12_500,
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
    expect(applications[0]).toMatchObject({ treatment: "CUSTOMER_RECEIVABLE", amountMinor: 12_500_000 });
    const rows = await journalRows(s);
    // Reading the rows, in order: (1) deposit received, Dr 1100 cash / Cr 2100 customer deposits; (2) completion applies
    // the deposit, Dr 2100 / Cr 1200 customer receivable (the 1200 credit is the deposit settling the invoice);
    // (3) the sale posts the invoice, Dr 1200 / Cr 2400 supplier payable 10,000,000 + Cr 4170 commission 2,500,000.
    // The 1200 debit and credit net to zero: customer AR is settled by the deposit, not by a receipt, which is why
    // SCRUM-802 can require the full price as a deposit before a cash sale completes.
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 12_500_000,
      "2400|JOD": 10_000_000,
      "4170|JOD": 2_500_000,
    });
  });

  test("SOURCED CASH × applied deposit × cancellation × refund: customer money returns without supplier debt", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedrefund", 12_500);
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 12_500,
      method: "CASH",
      idempotencyKey: "scrum486-sourced-refund-hold",
    });
    const saleId = await completeCashSale(s, quoteId, "sourced-refund");
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 12_500_000,
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
    expect(cancelled.deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 12_500_000 });
    expect(cancelled.applications.map((application) => application.status)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    const cancellationRows = await journalRows(s);
    expect(netByAccount(cancellationRows)).toEqual({ "1100|JOD": 12_500_000, "2100|JOD": -12_500_000 });
    expectBalanced(cancellationRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": 12_500_000, "2100|JOD": 12_500_000 });

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

  test("owned CASH × held/applied deposit: 12,500,000 liability reduces the invoice receivable, not revenue", async () => {
    const { s, quoteId } = await cashQuote("s486cashapplied");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 12_500,
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
      { account: "1100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
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
      amount: 12_500,
      method: "CASH",
      idempotencyKey: "scrum486-cancel-refund-hold",
    });
    const saleId = await completeCashSale(s, quoteId, "cancel-refund");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 12_500_000,
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
    expect(cancelled.deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 12_500_000 });
    expect(cancelled.applications.map((application) => application.status)).toEqual(["REVERSED"]);
    const cancellationRows = await journalRows(s);
    expect(netByAccount(cancellationRows)).toEqual({ "1100|JOD": 12_500_000, "2100|JOD": -12_500_000 });
    expectBalanced(cancellationRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": 12_500_000, "2100|JOD": 12_500_000 });

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
      orgId: s.orgId, quoteId, amount: 12_500, method: "CASH",
      idempotencyKey: "s486-foreign-source-deposit",
    });
    const other = await authorizedOtherTenant(s, "s486foreignids");
    const before = await dbSnapshot(s.t, Object.keys(schema.tables));

    await expect(other.owner.mutation(api.deposits.create, {
      orgId: other.orgId, quoteId, amount: 12_500, method: "CASH",
      idempotencyKey: "s486-foreign-quote-denied",
    })).rejects.toThrow(/Quote not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);

    await expect(other.owner.mutation(api.deposits.release, {
      orgId: other.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH",
      idempotencyKey: "s486-foreign-deposit-denied",
    })).rejects.toThrow(/Deposit not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
    expect(netByAccount(await journalRows(s))).toEqual({ "1100|JOD": 12_500_000, "2100|JOD": -12_500_000 });

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

// ─── SCRUM-760: deal unwind and vehicle cost correction cells ────────────────
//
// Owner ruling (SCRUM-760, recorded in the oracle's "Pilot subset"): deal unwind
// of a financed deal and `correctAcquisitionCost` are both needed for the pilot,
// so each is a full-behaviour cell here, not an expected-refusal cell. The one
// exception is the customer-credit PAYOUT exit of an unwind, which stays blocked
// (CUSTOMER_CREDIT_PAYOUT_DISABLED) and is pinned as its own expected-refusal cell.
// Expected values are literals derived from the owner's rulings (SCRUM-693
// c22112/22118/22129/22134, SCRUM-713, SCRUM-719, SCRUM-712, SCRUM-725), not from
// the application's posting helpers.

const ALL_TABLES: readonly string[] = Object.keys(schema.tables);

/** Every row of every table, for "a refusal wrote nothing" assertions. */
type SnapshotHandle = { t: CashSeed["t"] };
const fullTables = (s: SnapshotHandle) => dbSnapshot(s.t, ALL_TABLES);

/**
 * The call is refused, with the given machine code and/or message, and a full
 * before/after of every schema table shows no change. A caught exception can
 * commit a Convex mutation, so the error alone is never the evidence.
 */
async function expectRefusedAndUnchanged(
  s: SnapshotHandle,
  call: () => Promise<unknown>,
  expected: { code?: string; message?: RegExp },
) {
  const before = await fullTables(s);
  const refusal = await refusalDataOf(call());
  expect(refusal, "the call must be refused").not.toBeNull();
  if (expected.code !== undefined) expect(refusal?.code).toBe(expected.code);
  if (expected.message !== undefined) expect(refusal?.message).toMatch(expected.message);
  expect(await fullTables(s)).toEqual(before);
}

/**
 * Oracle mutation attack (gate item 2): every single-line mutation of the
 * literal expectation (drop a line, move one minor unit, move a line to another
 * account, flip original/reversal status) must be rejected by the comparator.
 */
function expectOracleRejectsEveryMutant(actual: JournalRow[], expected: JournalRow[]) {
  expectLiteralRows(actual, expected);
  let attacked = 0;
  expected.forEach((line, index) => {
    const mutants: Record<string, JournalRow[]> = {
      dropped: expected.filter((_, i) => i !== index),
      amountPlusOne: expected.map((row, i) => i !== index ? row : (
        row.debit > 0 ? { ...row, debit: row.debit + 1 } : { ...row, credit: row.credit + 1 })),
      wrongAccount: expected.map((row, i) => i === index ? { ...row, account: "9999" } : row),
      flippedStatus: expected.map((row, i) => i === index
        ? { ...row, entryStatus: row.entryStatus === "POSTED" ? "REVERSED" : "POSTED" } : row),
    };
    for (const [name, mutant] of Object.entries(mutants)) {
      expect(() => expectLiteralRows(actual, mutant), `oracle mutant ${name} of line ${index} (${line.account}) must be red`).toThrow();
      attacked += 1;
    }
  });
  expect(attacked).toBe(expected.length * 4);
}

/** Stored account snapshots of one period, summed over shards, as the trial-balance consumer reads them. */
async function storedPeriodSnapshot(s: CashSeed, periodId: Id<"accountingPeriods">) {
  return await s.t.run(async (ctx) => {
    const rows = await ctx.db.query("accountBalanceSnapshots")
      .withIndex("by_org_period", (q) => q.eq("orgId", s.orgId).eq("periodId", periodId)).collect();
    const totals = new Map<string, { debit: number; credit: number }>();
    for (const row of rows) {
      const code = (await ctx.db.get(row.accountId))?.code ?? "?";
      const key = `${code}|${row.currency}`;
      const old = totals.get(key) ?? { debit: 0, credit: 0 };
      totals.set(key, { debit: old.debit + row.runningDebitMinor, credit: old.credit + row.runningCreditMinor });
    }
    return Object.fromEntries([...totals].filter(([, v]) => v.debit !== 0 || v.credit !== 0).sort());
  });
}

const UNWIND_PERMS = [...OWNER_PERMS, "cancel:closed_deal", "confirm:finance_disbursement",
  "manage:commissions", "view:commissions", "manage:supplier_settlement", "view:cost_price"];

/** The two unwind authorities are both required (SCRUM-719); neither alone suffices. */
const UNWIND_ACTORS = {
  salesperson: ["view:sales", "edit:sales", "view:finance_applications", "create:finance_application"],
  confirmOnly: ["view:sales", "view:finance_applications", "confirm:finance_disbursement"],
  cancelOnly: ["view:sales", "view:finance_applications", "cancel:closed_deal"],
  /** Holds both unwind authorities (like the default MANAGER) but not MANAGE_FINANCE, the payout authority. */
  unwinder: ["view:sales", "view:finance_applications", "cancel:closed_deal", "confirm:finance_disbursement"],
};

let vinSequence = 0;
/** A valid 17-character VIN (no I, O or Q), unique within the test file. */
const nextVin = () => `1HGCM82633A${String(++vinSequence).padStart(6, "0")}`;
const carArgs = (vin: string = nextVin()) => ({
  vin, make: "Kia", model: "Sportage", year: 2024, mileage: 10, color: "Blue",
  fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_500, status: "AVAILABLE" as const,
  sourceType: "STOCK" as const,
});

/**
 * Owned configured-financier deal with the owner's SCRUM-435 worked numbers, driven
 * only through public mutations: a car bought for 10,000 cash, a 200 held deposit,
 * 87.4% LTV so the dealer contributes 1,375, the 1,575 forward to the finance
 * company, finalization, and the finance company's 12,500 into one bank. A manual
 * 250 commission accrues on the sale. State at return: bank 12,500,000.
 */
async function paidFinancedDealWithDeposit(tag: string, opts: { rail?: "BANK_TRANSFER" | "CASH" } = {}) {
  const rail = opts.rail ?? "BANK_TRANSFER";
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: UNWIND_PERMS, actors: UNWIND_ACTORS, label: "Certification", vinPrefix: "V760",
  });
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.companyId, { defaultLtvPercent: 87.4 });
    const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
    await ctx.db.patch(settings!._id, { commissionMode: "MANUAL" });
  });
  const bankId = await seedBank(s.t, s.orgId);
  const vehicleId = (await s.owner.as.mutation(api.vehicles.create, {
    orgId: s.orgId, ...carArgs(), purchasePrice: 10_000, purchasePaymentMethod: "CASH",
    idempotencyKey: `${tag}-buy-car`,
  })) as Id<"vehicles">;
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId, mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId, customerEligibilityStatusIds: [s.customerStatusId],
    vehiclePrice: 12_500, downPayment: 200, totalFinancedAmount: 12_300, termMonths: 48,
  });
  const depositId = await s.owner.as.mutation(api.deposits.create, {
    orgId: s.orgId, quoteId, amount: 200, method: "CASH", idempotencyKey: `${tag}-deposit`,
  });
  const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Unwind example.",
  });
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: rail, expectedDate: Date.now(),
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: `${tag}-zero-fee`, orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
    actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "No fee to settle.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  await s.approver.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: bankId, paidAt: Date.now(),
    expectedAmountMinor: 1_575_000, reference: "CERT-FORWARD", idempotencyKey: `${tag}-forward`,
  });
  await s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey: `${tag}-finalize`, orgId: s.orgId, applicationId });
  await s.owner.as.mutation(api.bankAccounts.setReconciliationTarget, { orgId: s.orgId, bankAccountId: bankId });
  await s.approver.as.mutation(api.applications.confirmDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000, idempotencyKey: `${tag}-receipt`, ...(rail === "BANK_TRANSFER" ? { bankAccountId: bankId } : {}),
  });
  const application = await s.t.run((ctx) => ctx.db.get(applicationId));
  const saleId = application!.finalizedSaleId!;
  await s.owner.as.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId, commissionAmount: 250 });
  return { s, applicationId, saleId, depositId, vehicleId, quoteId, bankId };
}
type PaidDeal = Awaited<ReturnType<typeof paidFinancedDealWithDeposit>>;

const startUnwind = (d: PaidDeal, key: string, as = d.s.owner.as) =>
  as.mutation(api.dealUnwind.startDealUnwind, {
    orgId: d.s.orgId, applicationId: d.applicationId, reason: "Customer returned the car.", idempotencyKey: key,
  });
const returnForward = (d: PaidDeal, unwindId: Id<"dealUnwinds">, key: string, as = d.s.owner.as) =>
  as.mutation(api.dealUnwind.recordDealUnwindForwardReturn, {
    orgId: d.s.orgId, unwindId, returnedAt: Date.now(), reference: "FC-RET-1", idempotencyKey: key,
  });
const finishArgsFor = (d: PaidDeal, unwindId: Id<"dealUnwinds">, key: string, over: Record<string, unknown> = {}) => ({
  orgId: d.s.orgId, unwindId, method: "BANK_TRANSFER" as const, refundedAt: Date.now(), bankReference: "TRF-998",
  creditNoteReference: "CN-77", vehicleReturnedAt: Date.now(), vehicleReturnNote: "Returned to the lot.",
  customerPaymentDisposition: "RETAIN_CREDIT" as const, idempotencyKey: key, ...over,
});

const J = (
  account: string, debit: number, credit: number, entryStatus: "POSTED" | "REVERSED" = "POSTED",
): JournalRow => ({ account, currency: "JOD", debit, credit, entryStatus });

/** A reversed event: each original line becomes REVERSED and is followed by its exact mirror as a POSTED line. */
const reversedWithMirror = (lines: JournalRow[]): JournalRow[] => lines.flatMap((line) => [
  { ...line, entryStatus: "REVERSED" as const },
  { ...line, debit: line.credit, credit: line.debit, entryStatus: "POSTED" as const },
]);

// The owner's worked financed example, one event at a time (oracle: SCRUM-435 numbers).
const CAR_BOUGHT = [J("1400", 10_000_000, 0), J("1100", 0, 10_000_000)];
const DEPOSIT_HELD = [J("1100", 200_000, 0), J("2100", 0, 200_000)];
const FORWARD_PAID = [J("2220", 1_575_000, 0), J("1110", 0, 1_575_000)];
const FINANCED_SALE = [
  J("1210", 12_500_000, 0), J("4100", 0, 12_500_000), J("5100", 10_000_000, 0), J("1400", 0, 10_000_000),
  J("4180", 1_375_000, 0), J("2220", 0, 1_375_000), J("2100", 200_000, 0), J("2220", 0, 200_000),
];
const FINANCIER_RECEIPT = [J("1110", 12_500_000, 0), J("1210", 0, 12_500_000)];
const COMMISSION_ACCRUED = [J("6100", 250_000, 0), J("2300", 0, 250_000)];

const PAID_DEAL_ROWS = [
  ...CAR_BOUGHT, ...DEPOSIT_HELD, ...FORWARD_PAID, ...FINANCED_SALE, ...FINANCIER_RECEIPT, ...COMMISSION_ACCRUED,
];
const FORWARD_RETURNED_ROWS = [
  ...CAR_BOUGHT, ...DEPOSIT_HELD, ...reversedWithMirror(FORWARD_PAID), ...FINANCED_SALE, ...FINANCIER_RECEIPT,
  ...COMMISSION_ACCRUED,
];
/** Everything the deal posted is reversed; only the car purchase and the held customer deposit stand. */
const UNWOUND_ROWS = [
  ...CAR_BOUGHT, ...DEPOSIT_HELD, ...reversedWithMirror(FORWARD_PAID), ...reversedWithMirror(FINANCED_SALE),
  ...reversedWithMirror(FINANCIER_RECEIPT), ...reversedWithMirror(COMMISSION_ACCRUED),
];

const PAID_DEAL_TRIAL_BALANCE = {
  "1100|JOD": -9_800_000, "1110|JOD": 10_925_000, "2300|JOD": 250_000, "4100|JOD": 12_500_000,
  "4180|JOD": -1_375_000, "5100|JOD": 10_000_000, "6100|JOD": 250_000,
};
const FORWARD_RETURNED_TRIAL_BALANCE = {
  ...PAID_DEAL_TRIAL_BALANCE, "1110|JOD": 12_500_000, "2220|JOD": 1_575_000,
};
/** Car on the shelf (cash 10,000 paid), customer's 200 held as a liability, nothing sold. */
const UNWOUND_TRIAL_BALANCE = { "1100|JOD": -9_800_000, "1400|JOD": 10_000_000, "2100|JOD": 200_000 };

async function bankBalanceMinor(s: CashSeed) {
  const report = await s.owner.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId });
  expect(report?.status).toBe("OK");
  return report?.balanceMinor;
}

async function dealRows(d: PaidDeal) {
  return await d.s.t.run(async (ctx) => {
    const application = await ctx.db.get(d.applicationId);
    const financeInvoice = await ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", d.s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", d.applicationId)).unique();
    return {
      application: application?.status,
      sale: (await ctx.db.get(d.saleId))?.status,
      vehicle: await ctx.db.get(d.vehicleId),
      deposit: await ctx.db.get(d.depositId),
      depositApplications: (await ctx.db.query("depositApplications")
        .withIndex("by_sale", (q) => q.eq("saleId", d.saleId)).collect()).map((row) => row.status),
      pendings: (await ctx.db.query("depositCancellationPendings").collect())
        .map((row) => ({ status: row.status, amountMinor: row.amountMinor, currency: row.currency })),
      financeInvoice: financeInvoice?.status,
    };
  });
}

const PENDING_MESSAGE = /still needs a refund or forfeiture decision/;

async function unwoundDeal(tag: string, disposition: "RETAIN_CREDIT" | "REFUND" = "RETAIN_CREDIT") {
  const d = await paidFinancedDealWithDeposit(tag);
  const unwindId = await startUnwind(d, `${tag}-start`);
  await returnForward(d, unwindId, `${tag}-forward-return`);
  await d.s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
    finishArgsFor(d, unwindId, `${tag}-finish`, { customerPaymentDisposition: disposition }));
  return { d, unwindId };
}

describe("SCRUM-760 deal unwind and vehicle cost correction cells (harness only)", () => {
  test.each(["RETAIN_CREDIT", "REFUND"] as const)(
    "U-RET owned financed unwind × held 200 deposit × zero credit (%s): start, forward return, finish restore the pre-sale books",
    async (disposition) => {
      const d = await paidFinancedDealWithDeposit(`s760uret${disposition.toLowerCase()}`);
      const { s } = d;
      const tag = `s760uret${disposition.toLowerCase()}`;
      const everyTable = () => fullTables(s);

      // Checkpoint 0: the deal as paid, before any unwind step.
      expectLiteralRows(await journalRows(s), PAID_DEAL_ROWS);
      expect(await trialBalanceNormalBalance(s)).toEqual(PAID_DEAL_TRIAL_BALANCE);
      expect(await bankBalanceMinor(s)).toBe(10_925_000);
      expect(await publicIncomeStatement(s)).toMatchObject({
        totalRevenue: 11_125_000, totalCogs: 10_000_000, grossProfit: 1_125_000, netIncome: 875_000,
      });
      expect(await dealRows(d)).toMatchObject({
        application: "CLOSED", sale: "COMPLETED", depositApplications: ["APPLIED"], pendings: [], financeInvoice: "PAID",
        vehicle: { status: "SOLD", purchasePrice: 10_000 }, deposit: { status: "APPLIED" },
      });

      // Refusals before the first step: nothing is written, whichever door or actor.
      const startCall = (as: typeof s.owner.as, key: string) => () => startUnwind(d, key, as);
      await expectRefusedAndUnchanged(s, startCall(s.actors.salesperson.as, `${tag}-r1`), {
        code: "FORBIDDEN", message: /cancel:closed_deal, confirm:finance_disbursement/,
      });
      await expectRefusedAndUnchanged(s, startCall(s.actors.confirmOnly.as, `${tag}-r2`), {
        code: "FORBIDDEN", message: /cancel:closed_deal/,
      });
      await expectRefusedAndUnchanged(s, startCall(s.actors.cancelOnly.as, `${tag}-r3`), {
        code: "FORBIDDEN", message: /confirm:finance_disbursement/,
      });
      const other = await authorizedOtherTenant(s, tag);
      await expectRefusedAndUnchanged(s, () => other.owner.mutation(api.dealUnwind.startDealUnwind, {
        orgId: other.orgId, applicationId: d.applicationId, reason: "Foreign attempt.", idempotencyKey: `${tag}-r4`,
      }), { code: "DEAL_UNWIND_NOT_FOUND" });

      // Step 1: start only locks the deal and snapshots the remittance. It posts nothing.
      const unwindId = await startUnwind(d, `${tag}-start`);
      expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({
        status: "ACTIVE", remittanceMinor: 12_500_000, remittanceMethod: "BANK_TRANSFER", forwardDueMinor: 1_575_000,
      });
      expectLiteralRows(await journalRows(s), PAID_DEAL_ROWS);
      expect(await bankBalanceMinor(s)).toBe(10_925_000);
      const afterStart = await everyTable();
      expect(await startUnwind(d, `${tag}-start`)).toEqual(unwindId); // exact-key retry
      expect(await everyTable()).toEqual(afterStart);
      await expectRefusedAndUnchanged(s, startCall(s.owner.as, `${tag}-again`), { code: "DEAL_UNWIND_ALREADY_ACTIVE" });
      // While the unwind is open no other door may move the deal's money.
      await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId: d.applicationId, reason: "Bypass attempt", idempotencyKey: `${tag}-bypass`,
      }), { code: "DEAL_UNWIND_ACTIVE" });
      // The refund step cannot run before the finance company's forward is returned.
      await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
        finishArgsFor(d, unwindId, `${tag}-early-finish`)), { code: "DEAL_UNWIND_FORWARD_FIRST" });
      await expectRefusedAndUnchanged(s, () => returnForward(d, unwindId, `${tag}-r5`, s.actors.salesperson.as), {
        code: "FORBIDDEN", message: /confirm:finance_disbursement/,
      });

      // Step 2: the finance company returns the 1,575 forward. Only that payment reverses.
      await returnForward(d, unwindId, `${tag}-forward-return`);
      expectLiteralRows(await journalRows(s), FORWARD_RETURNED_ROWS);
      expect(await trialBalanceNormalBalance(s)).toEqual(FORWARD_RETURNED_TRIAL_BALANCE);
      expect(await bankBalanceMinor(s)).toBe(12_500_000);
      expect((await dealRows(d)).sale).toBe("COMPLETED");

      // Step 3 refusals: the refund must go back by the rail the receipt arrived on, and needs both authorities.
      await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
        finishArgsFor(d, unwindId, `${tag}-wrong-rail`, {
          method: "CASH", bankReference: undefined, voucherNumber: "PV-1", recipientAcknowledged: true,
        })), { code: "DEAL_UNWIND_REFUND_METHOD_MISMATCH" });
      await expectRefusedAndUnchanged(s, () => s.actors.salesperson.as.mutation(api.dealUnwind.finishDealUnwind,
        finishArgsFor(d, unwindId, `${tag}-r6`)), { code: "FORBIDDEN" });
      await expectRefusedAndUnchanged(s, () => s.actors.cancelOnly.as.mutation(api.dealUnwind.finishDealUnwind,
        finishArgsFor(d, unwindId, `${tag}-r7`)), { code: "FORBIDDEN", message: /confirm:finance_disbursement/ });

      // Step 3: finish. One transaction refunds the remittance and cancels the deal.
      const finish = finishArgsFor(d, unwindId, `${tag}-finish`, { customerPaymentDisposition: disposition });
      await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, finish);
      const finalRows = await journalRows(s);
      expectOracleRejectsEveryMutant(finalRows, UNWOUND_ROWS);
      expectBalanced(finalRows);
      expect(netByAccount(finalRows)).toEqual({ "1100|JOD": -9_800_000, "1400|JOD": 10_000_000, "2100|JOD": -200_000 });
      expect(await trialBalanceNormalBalance(s)).toEqual(UNWOUND_TRIAL_BALANCE);
      expect(await bankBalanceMinor(s)).toBe(0);
      expect(await publicIncomeStatement(s)).toMatchObject({
        totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
      });
      const after = await dealRows(d);
      expect(after).toMatchObject({
        application: "CANCELLED", sale: "CANCELLED", financeInvoice: "CANCELLED",
        // The car is back, untouched in cost, and parked for inspection (D3).
        vehicle: { status: "IN_INSPECTION", purchasePrice: 10_000 },
        // The customer's 200 is held again, not refunded, and the car may not be resold until it is decided.
        deposit: { status: "HELD", holdActive: true, amountMinor: 200_000 },
        depositApplications: ["REVERSED"],
        pendings: [{ status: "PENDING", amountMinor: 200_000, currency: "JOD" }],
      });
      expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({
        status: "COMPLETED",
        completion: { customerPaymentDisposition: disposition, customerReceiptSettlement: { refundedMinor: 0, retainedMinor: 0 } },
        remittanceRefund: { amountMinor: 12_500_000, method: "BANK_TRANSFER", receiptReversal: "REVERSED" },
      });
      // The finance receivable invoice, its payment and the unpaid commission accrual are gone too.
      expect(await eventStatuses(s, "SALE_COMPLETED", d.saleId)).toEqual(["REVERSED"]);
      expect(await eventStatuses(s, "COMMISSION_ACCRUED", `commission_${d.saleId}`, "sales")).toEqual(["REVERSED"]);
      expect(await s.t.run(async (ctx) => (await ctx.db.query("canonicalPayments")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter((p) => p.direction === "IN" && p.status === "VOIDED").length))
        .toBe(1);
      // The deposit's pending decision blocks availability.
      await expectRefusedAndUnchanged(s, () => d.s.owner.as.mutation(api.vehicles.update, {
        orgId: s.orgId, vehicleId: d.vehicleId, status: "AVAILABLE",
      }), { message: PENDING_MESSAGE });
      // Replays of the finished step change nothing.
      const finished = await everyTable();
      await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, finish);
      expect(await everyTable()).toEqual(finished);
      await expectRefusedAndUnchanged(s, () => returnForward(d, unwindId, `${tag}-late-forward`), {
        code: "DEAL_UNWIND_NOT_ACTIVE",
      });
      // A fresh-key cancel of the already-cancelled deal, even by a plain salesperson, must not touch the deposit hold
      // the unwind reinstated: the only table that may change is the idempotency record.
      for (const [who, as] of [["salesperson", s.actors.salesperson.as], ["owner", s.owner.as]] as const) {
        const beforeRecancel = await everyTable();
        await as.mutation(api.applications.cancelApplication, {
          orgId: s.orgId, applicationId: d.applicationId, reason: "Cancel again", idempotencyKey: `${tag}-recancel-${who}`,
        });
        const afterRecancel = await everyTable();
        expect(ALL_TABLES.filter((table) =>
          JSON.stringify(afterRecancel[table]) !== JSON.stringify(beforeRecancel[table]))).toEqual(["commandIdempotency"]);
        expect((await dealRows(d)).deposit).toMatchObject({ status: "HELD", holdActive: true });
      }
      // The reversed deal cannot be re-posted by a late or repeated money step: each is refused and writes nothing.
      const approver = s.approver.as;
      await expectRefusedAndUnchanged(s, () => approver.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId, applicationId: d.applicationId, disbursedAmountMinor: 12_500_000,
        idempotencyKey: `${tag}-receipt`, bankAccountId: d.bankId,
      }), { code: "FINANCE_CONFIRM_STALE_REQUEST" });
      await expectRefusedAndUnchanged(s, () => approver.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId, applicationId: d.applicationId, disbursedAmountMinor: 12_500_000,
        idempotencyKey: `${tag}-receipt-again`, bankAccountId: d.bankId,
      }), { code: "FINANCE_CONFIRM_STALE_REQUEST" });
      await expectRefusedAndUnchanged(s, () => approver.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
        orgId: s.orgId, applicationId: d.applicationId, method: "BANK_TRANSFER", bankAccountId: d.bankId,
        paidAt: Date.now(), expectedAmountMinor: 1_575_000, reference: "again", idempotencyKey: `${tag}-forward-again`,
      }), { message: /must be approved before the payment/ });
      await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.applications.finalizeDeal, {
        idempotencyKey: `${tag}-finalize-again`, orgId: s.orgId, applicationId: d.applicationId,
      }), { message: /must be APPROVED before finalizing/ });
      await expectRefusedAndUnchanged(s, () => startUnwind(d, `${tag}-unwind-again`), { code: "DEAL_UNWIND_NOT_ELIGIBLE" });
      await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.sales.setCommissionAmount, {
        orgId: s.orgId, saleId: d.saleId, commissionAmount: 300,
      }), { code: "VALIDATION_FAILED", message: /cancelled sale cannot be given a commission/ });
    },
    30_000,
  );

  test.each([
    { exit: "REFUNDED" as const, counter: "1100", incomeOther: 0 },
    { exit: "FORFEITED" as const, counter: "4200", incomeOther: 200_000 },
  ])("U-RET exit: after the unwind the held 200 deposit is $exit, which releases the car", async ({ exit, counter, incomeOther }) => {
    const { d } = await unwoundDeal(`s760exit${exit.toLowerCase()}`);
    const { s } = d;
    expect((await dealRows(d)).pendings).toEqual([{ status: "PENDING", amountMinor: 200_000, currency: "JOD" }]);
    // Only an authorized decision, through the existing deposit door, moves the customer's money.
    await expectRefusedAndUnchanged(s, () => s.actors.salesperson.as.mutation(api.deposits.release, {
      orgId: s.orgId, depositId: d.depositId, resolution: exit,
      ...(exit === "REFUNDED" ? { refundMethod: "CASH" as const } : {}), idempotencyKey: `${exit}-denied`,
    }), { code: "FORBIDDEN" });
    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId, depositId: d.depositId, resolution: exit,
      ...(exit === "REFUNDED" ? { refundMethod: "CASH" as const } : {}), idempotencyKey: `${exit}-release`,
    });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      ...UNWOUND_ROWS, J("2100", 200_000, 0), J(counter, 0, 200_000),
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual(
      exit === "REFUNDED"
        ? { "1100|JOD": -10_000_000, "1400|JOD": 10_000_000 }
        : { "1100|JOD": -9_800_000, "1400|JOD": 10_000_000, "4200|JOD": 200_000 },
    );
    expect((await publicIncomeStatement(s)).totalOtherIncome).toBe(incomeOther);
    const after = await dealRows(d);
    expect(after.deposit).toMatchObject({ status: exit });
    expect(after.pendings.map((row) => row.status)).not.toContain("PENDING");
    // The decision lifts the block: the car can return to the lot.
    await d.s.owner.as.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: d.vehicleId, status: "AVAILABLE" });
    expect((await dealRows(d)).vehicle).toMatchObject({ status: "AVAILABLE", purchasePrice: 10_000 });
  }, 30_000);

  test("U-RET × cost correction: the returned car's cost can be corrected and still equals Vehicle Inventory", async () => {
    const { d } = await unwoundDeal("s760unwindcorrect");
    const { s } = d;
    // The unwind never touches the car's cost: GL 1400 (10,000,000) equals purchasePrice (10,000).
    expect(await trialBalanceNormalBalance(s)).toMatchObject({ "1400|JOD": 10_000_000 });
    await s.owner.as.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: s.orgId, vehicleId: d.vehicleId, newCost: 9_500, reason: "Supplier credited the dealer.",
      correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });
    expect((await dealRows(d)).vehicle).toMatchObject({ status: "IN_INSPECTION", purchasePrice: 9_500 });
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": -9_300_000, "1400|JOD": 9_500_000, "2100|JOD": 200_000,
    });
  }, 30_000);

  test("U-ABANDON: abandoning leaves the paid deal exactly as it was, releases the lock and a later unwind completes", async () => {
    const d = await paidFinancedDealWithDeposit("s760abandon");
    const { s } = d;
    const other = await authorizedOtherTenant(s, "s760abandon");
    const abandon = (as: typeof s.owner.as, unwindId: Id<"dealUnwinds">, key: string, orgId = s.orgId) =>
      as.mutation(api.dealUnwind.abandonDealUnwind, { orgId, unwindId, reason: "Customer changed their mind.", idempotencyKey: key });

    // Abandon straight after start: nothing was undone, so nothing is restored.
    const first = await startUnwind(d, "s760abandon-start-1");
    // SCRUM-719: walking away needs the same two authorities as opening, and the right tenant.
    await expectRefusedAndUnchanged(s, () => abandon(s.actors.cancelOnly.as, first, "ab-r1"), { code: "FORBIDDEN" });
    await expectRefusedAndUnchanged(s, () => abandon(s.actors.confirmOnly.as, first, "ab-r2"), { code: "FORBIDDEN" });
    await expectRefusedAndUnchanged(s, () => abandon(s.actors.salesperson.as, first, "ab-r3"), { code: "FORBIDDEN" });
    await expectRefusedAndUnchanged(s, () => abandon(other.owner, first, "ab-r4", other.orgId), { code: "DEAL_UNWIND_NOT_FOUND" });
    const beforeAbandon = await fullTables(s);
    await abandon(s.owner.as, first, "ab-ok-1");
    expect(await s.t.run((ctx) => ctx.db.get(first))).toMatchObject({ status: "ABANDONED" });
    expectLiteralRows(await journalRows(s), PAID_DEAL_ROWS);
    expect(await trialBalanceNormalBalance(s)).toEqual(PAID_DEAL_TRIAL_BALANCE);
    expect(await bankBalanceMinor(s)).toBe(10_925_000);
    expect(await dealRows(d)).toMatchObject({
      application: "CLOSED", sale: "COMPLETED", financeInvoice: "PAID", pendings: [], depositApplications: ["APPLIED"],
      vehicle: { status: "SOLD" }, deposit: { status: "APPLIED" },
    });
    // Only the unwind row, its audit trail and the idempotency record moved.
    const afterAbandon = await fullTables(s);
    const changedTables = ALL_TABLES.filter((table) =>
      JSON.stringify(afterAbandon[table]) !== JSON.stringify(beforeAbandon[table]));
    expect([...changedTables].sort()).toEqual(["commandIdempotency", "dealUnwinds", "financialAuditLog"]);
    await expectRefusedAndUnchanged(s, () => abandon(s.owner.as, first, "ab-again"), { code: "DEAL_UNWIND_NOT_ACTIVE" });
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
      finishArgsFor(d, first, "ab-finish-abandoned")), { code: "DEAL_UNWIND_NOT_ACTIVE" });

    // Abandon after the forward return: the returned forward stays recorded, the deal stays paid and sold.
    const second = await startUnwind(d, "s760abandon-start-2");
    await returnForward(d, second, "s760abandon-fwd-2");
    await abandon(s.owner.as, second, "ab-ok-2");
    expectLiteralRows(await journalRows(s), FORWARD_RETURNED_ROWS);
    expect(await trialBalanceNormalBalance(s)).toEqual(FORWARD_RETURNED_TRIAL_BALANCE);
    expect(await bankBalanceMinor(s)).toBe(12_500_000);
    expect(await dealRows(d)).toMatchObject({ application: "CLOSED", sale: "COMPLETED", vehicle: { status: "SOLD" }, pendings: [] });

    // The lock is released: a third unwind (forward already returned, evidence only) completes the deal's reversal.
    const third = await startUnwind(d, "s760abandon-start-3");
    await returnForward(d, third, "s760abandon-fwd-3");
    await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, finishArgsFor(d, third, "s760abandon-finish-3"));
    const rows = await journalRows(s);
    expectLiteralRows(rows, UNWOUND_ROWS);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual(UNWOUND_TRIAL_BALANCE);
    expect(await bankBalanceMinor(s)).toBe(0);
    expect((await dealRows(d)).vehicle).toMatchObject({ status: "IN_INSPECTION" });
  }, 30_000);

  /**
   * Positive ACTIVE customer credit on the sale invoice: a customer cheque of 10 JOD clears, of which 4 is reserved
   * against the reopened invoice and 3 activated. The public receipt-application doors are dark in the pilot
   * (SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED), so this setup state can only come from the internal helpers; it models
   * legacy or pre-pilot data. The unwind under test is still driven through its public doors.
   */
  async function addActiveCustomerCredit(d: PaidDeal) {
    const { s } = d;
    const sale = await s.t.run((ctx) => ctx.db.get(d.saleId));
    const invoiceId = sale!.canonicalReceivableDocumentId!;
    await s.t.run((ctx) => ctx.db.patch(invoiceId, { originalAmountMinor: 4_000, status: "OPEN" }));
    const chequeId = await s.owner.as.mutation(api.collections.registerCheque, {
      orgId: s.orgId, customerId: s.customerId, bank: "Customer bank", chequeNumber: "S760-CREDIT",
      chequeDate: Date.now(), amount: 10,
    });
    const collectionId = await s.owner.as.mutation(api.collections.clearCheque, {
      orgId: s.orgId, chequeId, bankAccountId: d.bankId, idempotencyKey: "s760-credit-clear",
    });
    const movement = await s.t.run((ctx) => ctx.db.query("receiptMovements")
      .withIndex("by_org_payment", (q) => q.eq("orgId", s.orgId).eq("collectionPaymentId", collectionId)).unique());
    const reservationId = await s.t.run((ctx) => reservePendingInvoiceReceipt(ctx, {
      orgId: s.orgId, receiptMovementId: movement!._id, saleId: d.saleId, amountMinor: 4_000, actorId: s.owner.userId,
    }));
    await s.t.run((ctx) => activatePendingInvoiceReceipt(ctx, {
      orgId: s.orgId, applicationId: reservationId, amountMinor: 3_000, actorId: s.owner.userId,
    }));
    return { reservationId };
  }

  async function creditedDealAtFinishStep(tag: string) {
    const d = await paidFinancedDealWithDeposit(tag);
    const credit = await addActiveCustomerCredit(d);
    const unwindId = await startUnwind(d, `${tag}-start`);
    await returnForward(d, unwindId, `${tag}-forward-return`);
    return { d, unwindId, ...credit };
  }

  const PAYOUT_FIELDS = (d: PaidDeal, method: "BANK_TRANSFER" | "CASH") => ({
    customerRefundAmountMinor: 3_000, customerRefundMethod: method, customerRefundReference: "CUST-PAYOUT-1",
    customerRefundedAt: Date.now(), ...(method === "BANK_TRANSFER" ? { customerRefundBankAccountId: d.bankId } : {}),
  });

  test("U-REFUND: unwind REFUND of positive customer credit is refused CUSTOMER_CREDIT_PAYOUT_DISABLED with nothing changed", async () => {
    const real = await vi.importActual<typeof import("./utils/customerCreditPayoutContainment")>(
      "./utils/customerCreditPayoutContainment");
    // The shipped switch, read from the module itself: this cell must not run against a flipped value.
    expect(real.CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED).toBe(true);
    expect(guardAttack.payoutSwitchDisabled).toBeUndefined();

    const { d, unwindId, reservationId } = await creditedDealAtFinishStep("s760refund");
    const { s } = d;
    const finish = (key: string, over: Record<string, unknown>, as = s.owner.as) => () =>
      as.mutation(api.dealUnwind.finishDealUnwind, finishArgsFor(d, unwindId, key, over));
    const disabled = { code: "CUSTOMER_CREDIT_PAYOUT_DISABLED", message: /not available during the pilot/ };

    // Every way of asking for the customer's money back, by an otherwise authorized actor with valid arguments.
    await expectRefusedAndUnchanged(s, finish("rf-1", { customerPaymentDisposition: "REFUND" }), disabled);
    await expectRefusedAndUnchanged(s, finish("rf-2", { customerPaymentDisposition: "REFUND", ...PAYOUT_FIELDS(d, "BANK_TRANSFER") }), disabled);
    await expectRefusedAndUnchanged(s, finish("rf-3", { customerPaymentDisposition: "REFUND", ...PAYOUT_FIELDS(d, "CASH") }), disabled);
    await expectRefusedAndUnchanged(s, finish("rf-4", { customerPaymentDisposition: "RETAIN_CREDIT", ...PAYOUT_FIELDS(d, "BANK_TRANSFER") }), disabled);
    // Payout authority (MANAGE_FINANCE) is asked for before the pilot refusal; deal-cancel authority is not a substitute.
    await expectRefusedAndUnchanged(s, finish("rf-5", { customerPaymentDisposition: "REFUND" }, s.actors.unwinder.as),
      { code: "FORBIDDEN", message: /manage:finance/ });

    // The refusals left the unwind open, the credit active, no payout posted, and the books at the finish-step state.
    expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({ status: "ACTIVE" });
    expect(await s.t.run((ctx) => ctx.db.get(reservationId))).toMatchObject({ status: "ACTIVE" });
    expect(await s.t.run(async (ctx) => (await ctx.db.query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
      .filter((event) => event.eventType === "RETAINED_CREDIT_REFUNDED").length)).toBe(0);
    expect((await dealRows(d)).sale).toBe("COMPLETED");

    // The other half of the pilot contract: keeping the credit (no payout asked) still completes the unwind.
    await finish("rf-6", { customerPaymentDisposition: "RETAIN_CREDIT" })();
    expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({
      status: "COMPLETED",
      completion: { customerReceiptSettlement: { refundedMinor: 0, retainedMinor: 3_000 } },
    });
    expect(await s.t.run(async (ctx) => (await ctx.db.query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
      .filter((event) => event.eventType === "RETAINED_CREDIT_REFUNDED").length)).toBe(0);
    // Customer money is conserved: the 10 JOD cheque (bank 10,000) stays with the dealership as 2110 customer credit,
    // none of it paid out, and the deal's own postings are all reversed.
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": -9_800_000, "1110|JOD": 10_000, "1400|JOD": 10_000_000, "2100|JOD": -200_000, "2110|JOD": -10_000,
    });
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": -9_800_000, "1110|JOD": 10_000, "1400|JOD": 10_000_000, "2100|JOD": 200_000, "2110|JOD": 10_000,
    });
  }, 30_000);

  test("U-REFUND mutation attack: flipping the payout switch removes the refusal, so the cell above would be red", async () => {
    const { d, unwindId } = await creditedDealAtFinishStep("s760refundattack");
    const { s } = d;
    guardAttack.payoutSwitchDisabled = false;
    try {
      await expect(expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
        finishArgsFor(d, unwindId, "atk-1", { customerPaymentDisposition: "REFUND", ...PAYOUT_FIELDS(d, "BANK_TRANSFER") })),
      { code: "CUSTOMER_CREDIT_PAYOUT_DISABLED" })).rejects.toThrow();
    } finally {
      guardAttack.payoutSwitchDisabled = undefined;
    }
  }, 30_000);

  test("U-RET mutation attack: removing the pending-disposition availability guard lets the car back on the lot", async () => {
    const { d } = await unwoundDeal("s760pendingattack");
    guardAttack.skipPendingAvailabilityGuard = true;
    try {
      await expect(expectRefusedAndUnchanged(d.s, () => d.s.owner.as.mutation(api.vehicles.update, {
        orgId: d.s.orgId, vehicleId: d.vehicleId, status: "AVAILABLE",
      }), { message: PENDING_MESSAGE })).rejects.toThrow();
    } finally {
      guardAttack.skipPendingAvailabilityGuard = false;
    }
  }, 30_000);

  /**
   * A SOURCED car financed through the dealership: no deposit and no contribution, so no forward. The finance company
   * pays the dealership 12,500; the dealership owes the supplier 10,000 and keeps 2,500 agency margin.
   */
  async function sourcedThroughDealershipPaid(tag: string, route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") {
    const s = await seedFinancedDealership(tag, {
      modules: MODULES, ownerPerms: UNWIND_PERMS, actors: UNWIND_ACTORS, label: "Certification", vinPrefix: "V760",
      sourced: true,
    });
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 10_000 }));
    const bankId = await seedBank(s.t, s.orgId);
    const { applicationId } = await newApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Full vehicle price.",
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
      orgId: s.orgId, feeId, notes: "No fee to settle.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
    });
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId: s.orgId, applicationId, route });
    await s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey: `${tag}-finalize`, orgId: s.orgId, applicationId });
    await s.owner.as.mutation(api.bankAccounts.setReconciliationTarget, { orgId: s.orgId, bankAccountId: bankId });
    const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
    return { s, applicationId, saleId, bankId };
  }

  test("U-SOURCED: sourced through-dealership unwind reverses 1210/2400/4170, cancels the supplier payable and the receipt", async () => {
    const { s, applicationId, saleId, bankId } = await sourcedThroughDealershipPaid("s760sourcedunwind", "THROUGH_DEALERSHIP");
    const SOURCED_SALE = [J("1210", 12_500_000, 0), J("2400", 0, 10_000_000), J("4170", 0, 2_500_000)];
    await s.approver.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000, idempotencyKey: "s760sourced-receipt", bankAccountId: bankId,
    });
    expectLiteralRows(await journalRows(s), [...SOURCED_SALE, ...FINANCIER_RECEIPT]);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1110|JOD": 12_500_000, "2400|JOD": 10_000_000, "4170|JOD": 2_500_000 });
    expect(await bankBalanceMinor(s)).toBe(12_500_000);
    const payable = await s.t.run((ctx) => ctx.db.query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId)).unique());
    expect(payable).toMatchObject({ amountDue: 10_000, status: "PENDING" });

    const call = (as: typeof s.owner.as, key: string) => () => as.mutation(api.dealUnwind.startDealUnwind, {
      orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: key,
    });
    await expectRefusedAndUnchanged(s, call(s.actors.salesperson.as, "sr-1"), { code: "FORBIDDEN" });
    const unwindId = await call(s.owner.as, "s760sourced-start")() as Id<"dealUnwinds">;
    expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({ status: "ACTIVE", forwardDueMinor: 0 });
    // No deposit and no contribution: there is no forwarded payment to return, so that step refuses and writes nothing.
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.recordDealUnwindForwardReturn, {
      orgId: s.orgId, unwindId, returnedAt: Date.now(), reference: "FC-RET-0", idempotencyKey: "sr-2",
    }), { code: "DEAL_UNWIND_FORWARD_NOT_APPLICABLE" });
    await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, {
      orgId: s.orgId, unwindId, method: "BANK_TRANSFER", refundedAt: Date.now(), bankReference: "TRF-SRC-1",
      creditNoteReference: "CN-SRC-1", vehicleReturnedAt: Date.now(), vehicleReturnNote: "Back at the lot.",
      customerPaymentDisposition: "RETAIN_CREDIT", idempotencyKey: "s760sourced-finish",
    });

    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [...reversedWithMirror(SOURCED_SALE), ...reversedWithMirror(FINANCIER_RECEIPT)]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await bankBalanceMinor(s)).toBe(0);
    expect(await publicIncomeStatement(s)).toMatchObject({ totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0 });
    expect(await s.t.run((ctx) => ctx.db.get(payable!._id))).toMatchObject({ status: "CANCELLED" });
    expect(await s.t.run(async (ctx) => ({
      application: (await ctx.db.get(applicationId))?.status,
      sale: (await ctx.db.get(saleId))?.status,
      vehicle: (await ctx.db.get(s.vehicleId))?.status,
      unwind: (await ctx.db.get(unwindId))?.status,
    }))).toEqual({ application: "CANCELLED", sale: "CANCELLED", vehicle: "IN_INSPECTION", unwind: "COMPLETED" });
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
  }, 30_000);

  test("U-SOURCED direct-to-supplier: the dealership never held the finance company's money, so the unwind door refuses and writes nothing", async () => {
    const { s, applicationId } = await sourcedThroughDealershipPaid("s760sourceddirect", "DIRECT_TO_SUPPLIER");
    // The 1240 supplier claim (2,500,000 against 4170) is the whole of this deal's books; no unwind exists for it.
    expectLiteralRows(await journalRows(s), [J("1240", 2_500_000, 0), J("4170", 0, 2_500_000)]);
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.startDealUnwind, {
      orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: "sd-1",
    }), { code: "DEAL_UNWIND_NOT_ELIGIBLE" });
    await s.owner.as.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000, reference: "CERT-SUPPLIER-ADVICE",
      idempotencyKey: "sd-advice",
    });
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.startDealUnwind, {
      orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: "sd-2",
    }), { code: "DEAL_UNWIND_NOT_ELIGIBLE" });
  }, 30_000);

  async function trialBalanceAsOf(s: CashSeed, toDate: number) {
    const report = await s.owner.as.query(api.accountingReports.trialBalance, { orgId: s.orgId, toDate });
    expect(report.isBalanced).toBe(true);
    return Object.fromEntries(report.rows
      .filter((row) => row.netMinor !== 0)
      .map((row) => [`${row.code}|${row.currency}`, row.netMinor] as const)
      .sort(([a], [b]) => a.localeCompare(b)));
  }

  test("U-RET closed period: unwinding next year's deal leaves the closed period's stored snapshots and reports untouched", async () => {
    vi.useFakeTimers();
    try {
      const year = new Date().getUTCFullYear();
      // The deal is sold and paid in mid prior year, inside that year's period.
      vi.setSystemTime(new Date(Date.UTC(year - 1, 5, 15, 12)));
      const d = await paidFinancedDealWithDeposit("s760closedperiod");
      const { s } = d;
      const periods = await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId });
      expect(periods).toHaveLength(1);
      const priorPeriodId = periods[0]._id;
      const priorEnd = Date.UTC(year - 1, 11, 31, 23, 59, 59, 999);

      // Next year: the new period opens, the prior one is closed through the public close.
      vi.setSystemTime(new Date(Date.UTC(year, 0, 20, 12)));
      const currentPeriodId = await s.owner.as.mutation(api.accountingPeriods.create, {
        orgId: s.orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
        fiscalYear: year, periodNumber: 1, openImmediately: true,
      });
      const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId: priorPeriodId });
      await s.owner.as.mutation(api.accountingPeriods.close, {
        orgId: s.orgId, periodId: priorPeriodId, acknowledgedWarnings: checklist.warnings,
      });
      expect((await s.t.run((ctx) => ctx.db.get(priorPeriodId)))?.status).toBe("CLOSED");

      const PRIOR_SNAPSHOT = {
        "1100|JOD": { debit: 200_000, credit: 10_000_000 }, "1110|JOD": { debit: 12_500_000, credit: 1_575_000 },
        "1210|JOD": { debit: 12_500_000, credit: 12_500_000 }, "1400|JOD": { debit: 10_000_000, credit: 10_000_000 },
        "2100|JOD": { debit: 200_000, credit: 200_000 }, "2220|JOD": { debit: 1_575_000, credit: 1_575_000 },
        "2300|JOD": { debit: 0, credit: 250_000 }, "4100|JOD": { debit: 0, credit: 12_500_000 },
        "4180|JOD": { debit: 1_375_000, credit: 0 }, "5100|JOD": { debit: 10_000_000, credit: 0 },
        "6100|JOD": { debit: 250_000, credit: 0 },
      };
      const CURRENT_SNAPSHOT_AFTER = {
        "1110|JOD": { debit: 1_575_000, credit: 12_500_000 }, "2220|JOD": { debit: 1_575_000, credit: 1_575_000 },
        "1210|JOD": { debit: 12_500_000, credit: 12_500_000 }, "2100|JOD": { debit: 0, credit: 200_000 },
        "4180|JOD": { debit: 0, credit: 1_375_000 }, "4100|JOD": { debit: 12_500_000, credit: 0 },
        "5100|JOD": { debit: 0, credit: 10_000_000 }, "1400|JOD": { debit: 10_000_000, credit: 0 },
        "6100|JOD": { debit: 0, credit: 250_000 }, "2300|JOD": { debit: 250_000, credit: 0 },
      };
      const priorYearIncome = () => s.owner.as.query(api.accountingReports.incomeStatement, {
        orgId: s.orgId, fromDate: Date.UTC(year - 1, 0, 1), toDate: priorEnd,
      });
      expect(await storedPeriodSnapshot(s, priorPeriodId)).toEqual(PRIOR_SNAPSHOT);
      expect(await storedPeriodSnapshot(s, currentPeriodId)).toEqual({});
      const priorTrialBalanceBefore = await trialBalanceAsOf(s, priorEnd);
      expect(priorTrialBalanceBefore).toEqual(PAID_DEAL_TRIAL_BALANCE);
      const priorIncomeBefore = await priorYearIncome();
      expect(priorIncomeBefore).toMatchObject({ totalRevenue: 11_125_000, totalCogs: 10_000_000, netIncome: 875_000 });
      const originalLines = await journalRows(s);
      expectLiteralRows(originalLines, PAID_DEAL_ROWS);

      // The unwind runs in the open period; a closed one is never rewritten.
      const unwindId = await startUnwind(d, "s760closed-start");
      await returnForward(d, unwindId, "s760closed-forward");
      await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, finishArgsFor(d, unwindId, "s760closed-finish"));

      expectLiteralRows(await journalRows(s), UNWOUND_ROWS);
      // Stored snapshots of the closed period: byte-for-byte as before. The reversal sits in the current period.
      expect(await storedPeriodSnapshot(s, priorPeriodId)).toEqual(PRIOR_SNAPSHOT);
      expect(await storedPeriodSnapshot(s, currentPeriodId)).toEqual(CURRENT_SNAPSHOT_AFTER);
      expect((await s.t.run((ctx) => ctx.db.get(priorPeriodId)))?.status).toBe("CLOSED");
      // The consumer reads the same: the prior year still reports the sale, the current year carries the reversal.
      expect(await trialBalanceAsOf(s, priorEnd)).toEqual(priorTrialBalanceBefore);
      expect(await priorYearIncome()).toEqual(priorIncomeBefore);
      expect(await trialBalanceNormalBalance(s)).toEqual(UNWOUND_TRIAL_BALANCE);
      expect(await s.owner.as.query(api.accountingReports.incomeStatement, {
        orgId: s.orgId, fromDate: Date.UTC(year, 0, 1), toDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      })).toMatchObject({ totalRevenue: -11_125_000, totalCogs: -10_000_000, netIncome: -875_000 });
      // Dates: original lines in the prior year, every reversal line in the current one.
      const dated = await s.t.run(async (ctx) => (await ctx.db.query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
        .map((line) => ({ reversal: (line.description ?? "").startsWith("[REVERSAL]"), year: new Date(line.accountingDate).getUTCFullYear() })));
      expect(dated.filter((line) => line.reversal).every((line) => line.year === year)).toBe(true);
      expect(dated.filter((line) => !line.reversal).every((line) => line.year === year - 1)).toBe(true);
      expect(dated.filter((line) => line.reversal)).toHaveLength(14);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  // ─── Vehicle cost correction (correctAcquisitionCost) ──────────────────────

  const CC_ACTORS = {
    /** The default ACCOUNTANT shape: MANAGE_FINANCE without VIEW_COST_PRICE. */
    accountant: ["view:vehicles", "view:finance", "manage:finance"],
  };

  async function costDealership(tag: string, over: { sourced?: boolean } = {}) {
    return await seedFinancedDealership(tag, {
      modules: MODULES, ownerPerms: UNWIND_PERMS, actors: CC_ACTORS, label: "Certification", vinPrefix: "V760C",
      ...(over.sourced ? { sourced: true } : {}),
    });
  }

  type CostDealership = Awaited<ReturnType<typeof costDealership>>;

  /** A car bought for 12,500 through the public door: Dr 1400 / Cr counter 12,500,000. */
  const buyCar = (s: CostDealership, tag: string, how: { method: "CASH" } | { method: "ON_ACCOUNT" }) =>
    s.owner.as.mutation(api.vehicles.create, {
      orgId: s.orgId, ...carArgs(), purchasePrice: 12_500, purchasePaymentMethod: how.method,
      ...(how.method === "ON_ACCOUNT" ? { purchaseSupplierName: "Credit Supplier Co" } : {}),
      idempotencyKey: `${tag}-buy`,
    }) as Promise<Id<"vehicles">>;

  const correct = (
    s: CostDealership, vehicleId: Id<"vehicles">, over: Record<string, unknown> = {}, as = s.owner.as,
  ) => as.mutation(api.vehicles.correctAcquisitionCost, {
    orgId: s.orgId, vehicleId, newCost: 9_800, reason: "Supplier invoice was for 9,800.",
    correctionType: "CASH_REFUND" as const, paymentMethod: "CASH" as const, ...over,
  });

  async function costRows(s: CostDealership, vehicleId: Id<"vehicles">) {
    return await s.t.run(async (ctx) => ({
      vehicle: await ctx.db.get(vehicleId),
      corrections: await ctx.db.query("vehicleCostCorrections")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", s.orgId).eq("vehicleId", vehicleId)).collect(),
      payables: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).collect(),
      cashbookCorrections: (await ctx.db.query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
        .filter((row) => (row.description ?? "").startsWith("Purchase cost correction")),
    }));
  }

  const CAR_12500_CASH = [J("1400", 12_500_000, 0), J("1100", 0, 12_500_000)];

  test("CC-CASH: a CASH_REFUND correction lowers cost, Vehicle Inventory and cash together; a sold car is refused", async () => {
    const s = await costDealership("s760cccash");
    const vehicleId = await buyCar(s, "s760cccash", { method: "CASH" });
    expectLiteralRows(await journalRows(s), CAR_12500_CASH);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": -12_500_000, "1400|JOD": 12_500_000 });

    // Refusals first, each with a full before/after of every table.
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, {}, s.actors.accountant.as), {
      code: "FORBIDDEN", message: /view:cost_price/,
    });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { newCost: 12_500 }), { code: "COST_CORRECTION_NO_CHANGE" });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { newCost: 9_800.0004 }), { code: "COST_CORRECTION_INVALID_AMOUNT" });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { correctionType: "SUPPLIER_INVOICE_ERROR" }), {
      code: "COST_CORRECTION_TYPE_NOT_ALLOWED",
    });
    // A restatement through retained earnings is only for a purchase booked in a closed period.
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { correctionType: "PRIOR_PERIOD_RESTATEMENT", paymentMethod: undefined }), {
      code: "COST_CORRECTION_RESTATEMENT_PERIOD_OPEN",
    });
    const other = await authorizedOtherTenant(s, "s760cccash");
    await expectRefusedAndUnchanged(s, () => other.owner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: other.orgId, vehicleId, newCost: 9_800, reason: "Foreign attempt.",
      correctionType: "CASH_REFUND", paymentMethod: "CASH",
    }), { message: /not found/i });

    // 12,500 -> 9,800: 2,700 comes back to the cash drawer and leaves inventory.
    await correct(s, vehicleId);
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [...CAR_12500_CASH, J("1100", 2_700_000, 0), J("1400", 0, 2_700_000)]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": -9_800_000, "1400|JOD": 9_800_000 });
    const afterFix = await costRows(s, vehicleId);
    expect(afterFix.vehicle?.purchasePrice).toBe(9_800);
    expect(afterFix.corrections).toHaveLength(1);
    expect(afterFix.corrections[0]).toMatchObject({ previousCost: 12_500, newCost: 9_800, correctionType: "CASH_REFUND" });
    // The cashbook agrees with the ledger: one IN of 2,700 for the refund.
    expect(afterFix.cashbookCorrections).toHaveLength(1);
    expect(afterFix.cashbookCorrections[0]).toMatchObject({ type: "IN", amount: 2_700, category: "VEHICLE_PURCHASE" });
    // A repeat of the same correction is a convergent no-op refusal, never a second posting.
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId), { code: "COST_CORRECTION_NO_CHANGE" });

    // The corrected cost is what the sale recognizes: COGS 9,800,000, margin 2,700,000.
    const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId, mode: "CASH", vehiclePrice: 12_500, downPayment: 0, termMonths: 0,
    });
    // SCRUM-802 (pilot): a cash sale completes only once its full price is held as a deposit.
    await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 12_500, method: "CASH", idempotencyKey: "s760cccash-full-deposit",
    });
    await s.owner.as.mutation(api.sales.create, {
      orgId: s.orgId, idempotencyKey: "s760cccash-sale", quoteId, vehicleId, customerId: s.customerId,
      salespersonId: s.owner.userId, salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED",
    });
    expect(await trialBalanceNormalBalance(s)).toEqual({
      // Cash: -9,800,000 (the corrected purchase) + 12,500,000 (the full-price deposit) = +2,700,000, the margin; the
      // deposit settled the invoice, so no receivable remains.
      "1100|JOD": 2_700_000, "4100|JOD": 12_500_000, "5100|JOD": 9_800_000,
    });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 12_500_000, totalCogs: 9_800_000, grossProfit: 2_700_000, netIncome: 2_700_000,
    });
    // Once sold the cost is no longer correctable here: refused, nothing changes.
    expect((await costRows(s, vehicleId)).vehicle?.status).toBe("SOLD");
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { newCost: 9_000 }), { code: "COST_CORRECTION_SOLD" });

  }, 30_000);

  test("CC-AP: a SUPPLIER_INVOICE_ERROR correction on an ON_ACCOUNT car moves the payable and 2400 together", async () => {
    const s = await costDealership("s760ccap");
    const vehicleId = await buyCar(s, "s760ccap", { method: "ON_ACCOUNT" });
    const CAR_12500_AP = [J("1400", 12_500_000, 0), J("2400", 0, 12_500_000)];
    expectLiteralRows(await journalRows(s), CAR_12500_AP);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1400|JOD": 12_500_000, "2400|JOD": 12_500_000 });
    expect((await costRows(s, vehicleId)).payables).toMatchObject([{ amountDue: 12_500, status: "PENDING" }]);

    // Cash cannot have moved on an unpaid invoice: a cash refund is the wrong type for this car.
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId), { code: "COST_CORRECTION_TYPE_NOT_ALLOWED" });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, {
      newCost: 11_900, correctionType: "SUPPLIER_INVOICE_ERROR", paymentMethod: undefined,
    }, s.actors.accountant.as), { code: "FORBIDDEN", message: /view:cost_price/ });

    // The supplier's invoice was 11,900, not 12,500: we owe 600 less, and the car cost 600 less.
    await correct(s, vehicleId, { newCost: 11_900, correctionType: "SUPPLIER_INVOICE_ERROR", paymentMethod: undefined });
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [...CAR_12500_AP, J("2400", 600_000, 0), J("1400", 0, 600_000)]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1400|JOD": 11_900_000, "2400|JOD": 11_900_000 });
    const afterFix = await costRows(s, vehicleId);
    expect(afterFix.vehicle?.purchasePrice).toBe(11_900);
    expect(afterFix.payables).toMatchObject([{ amountDue: 11_900, status: "PENDING" }]);
    expect(afterFix.corrections).toMatchObject([
      { previousCost: 12_500, newCost: 11_900, correctionType: "SUPPLIER_INVOICE_ERROR", previousAmountDue: 12_500 },
    ]);
    // No cash moved, so the cashbook has nothing to say.
    expect(afterFix.cashbookCorrections).toEqual([]);
  }, 30_000);

  test("CC-RESTATE: a closed-period purchase is restated through retained earnings in the open period, the closed period untouched", async () => {
    vi.useFakeTimers();
    try {
      const year = new Date().getUTCFullYear();
      vi.setSystemTime(new Date(Date.UTC(year - 1, 5, 15, 12)));
      const s = await costDealership("s760ccrestate");
      const vehicleId = await buyCar(s, "s760ccrestate", { method: "CASH" });
      const priorPeriodId = (await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId }))[0]._id;
      const priorEnd = Date.UTC(year - 1, 11, 31, 23, 59, 59, 999);

      vi.setSystemTime(new Date(Date.UTC(year, 0, 20, 12)));
      const currentPeriodId = await s.owner.as.mutation(api.accountingPeriods.create, {
        orgId: s.orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
        fiscalYear: year, periodNumber: 1, openImmediately: true,
      });
      const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId: priorPeriodId });
      await s.owner.as.mutation(api.accountingPeriods.close, {
        orgId: s.orgId, periodId: priorPeriodId, acknowledgedWarnings: checklist.warnings,
      });
      const PRIOR_SNAPSHOT = { "1100|JOD": { debit: 0, credit: 12_500_000 }, "1400|JOD": { debit: 12_500_000, credit: 0 } };
      expect(await storedPeriodSnapshot(s, priorPeriodId)).toEqual(PRIOR_SNAPSHOT);
      expect(await storedPeriodSnapshot(s, currentPeriodId)).toEqual({});
      expect(await trialBalanceAsOf(s, priorEnd)).toEqual({ "1100|JOD": -12_500_000, "1400|JOD": 12_500_000 });
      const priorIncomeBefore = await s.owner.as.query(api.accountingReports.incomeStatement, {
        orgId: s.orgId, fromDate: Date.UTC(year - 1, 0, 1), toDate: priorEnd,
      });

      // The purchase sits in a closed period, so a restatement (no cash moves) is offered.
      await correct(s, vehicleId, { correctionType: "PRIOR_PERIOD_RESTATEMENT", paymentMethod: undefined });

      // Dr Retained Earnings / Cr Vehicle Inventory 2,700,000, dated now; no cash moved.
      const rows = await journalRows(s);
      expectOracleRejectsEveryMutant(rows, [...CAR_12500_CASH, J("3100", 2_700_000, 0), J("1400", 0, 2_700_000)]);
      expectBalanced(rows);
      expect(await storedPeriodSnapshot(s, priorPeriodId)).toEqual(PRIOR_SNAPSHOT);
      expect(await storedPeriodSnapshot(s, currentPeriodId)).toEqual({
        "3100|JOD": { debit: 2_700_000, credit: 0 }, "1400|JOD": { debit: 0, credit: 2_700_000 },
      });
      expect((await s.t.run((ctx) => ctx.db.get(priorPeriodId)))?.status).toBe("CLOSED");
      expect(await trialBalanceAsOf(s, priorEnd)).toEqual({ "1100|JOD": -12_500_000, "1400|JOD": 12_500_000 });
      expect(await trialBalanceNormalBalance(s)).toEqual({
        "1100|JOD": -12_500_000, "1400|JOD": 9_800_000, "3100|JOD": -2_700_000,
      });
      // The prior year's result is not rewritten, and the restatement is not current-year income either.
      expect(await s.owner.as.query(api.accountingReports.incomeStatement, {
        orgId: s.orgId, fromDate: Date.UTC(year - 1, 0, 1), toDate: priorEnd,
      })).toEqual(priorIncomeBefore);
      expect(await s.owner.as.query(api.accountingReports.incomeStatement, {
        orgId: s.orgId, fromDate: Date.UTC(year, 0, 1), toDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      })).toMatchObject({ totalRevenue: 0, totalCogs: 0, netIncome: 0 });
      const afterFix = await costRows(s, vehicleId);
      expect(afterFix.vehicle?.purchasePrice).toBe(9_800);
      expect(afterFix.corrections).toMatchObject([{ previousCost: 12_500, newCost: 9_800, correctionType: "PRIOR_PERIOD_RESTATEMENT" }]);
      expect(afterFix.cashbookCorrections).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  test("CC-SOURCED: a consigned (SOURCED) car has no inventory to correct, so the door refuses and writes nothing", async () => {
    const s = await costDealership("s760ccsourced", { sourced: true });
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 10_000 }));
    await expectRefusedAndUnchanged(s, () => correct(s, s.vehicleId), { code: "COST_CORRECTION_SOURCED" });
    await expectRefusedAndUnchanged(s, () => correct(s, s.vehicleId, {
      correctionType: "SUPPLIER_INVOICE_ERROR", paymentMethod: undefined,
    }), { code: "COST_CORRECTION_SOURCED" });
  }, 30_000);

  test("U-RET CASH remittance: the unwind refunds cash by cash and reverses the same books", async () => {
    const d = await paidFinancedDealWithDeposit("s760cashrail", { rail: "CASH" });
    const { s } = d;
    const CASH_RECEIPT = [J("1100", 12_500_000, 0), J("1210", 0, 12_500_000)];
    expectLiteralRows(await journalRows(s), [
      ...CAR_BOUGHT, ...DEPOSIT_HELD, ...FORWARD_PAID, ...FINANCED_SALE, ...CASH_RECEIPT, ...COMMISSION_ACCRUED,
    ]);
    // Only the forward moved the bank; the finance company's money arrived as cash.
    expect(await bankBalanceMinor(s)).toBe(-1_575_000);
    const unwindId = await startUnwind(d, "s760cashrail-start");
    expect(await s.t.run((ctx) => ctx.db.get(unwindId))).toMatchObject({ remittanceMethod: "CASH", remittanceMinor: 12_500_000 });
    await returnForward(d, unwindId, "s760cashrail-forward");
    // Wrong rail and missing cash evidence both refuse with nothing written.
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
      finishArgsFor(d, unwindId, "cr-1")), { code: "DEAL_UNWIND_REFUND_METHOD_MISMATCH" });
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
      finishArgsFor(d, unwindId, "cr-2", { method: "CASH", bankReference: undefined, voucherNumber: "PV-1", recipientAcknowledged: false })),
    { code: "DEAL_UNWIND_EVIDENCE_REQUIRED" });
    await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, finishArgsFor(d, unwindId, "s760cashrail-finish", {
      method: "CASH", bankReference: undefined, voucherNumber: "PV-1", recipientAcknowledged: true,
    }));
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [
      ...CAR_BOUGHT, ...DEPOSIT_HELD, ...reversedWithMirror(FORWARD_PAID), ...reversedWithMirror(FINANCED_SALE),
      ...reversedWithMirror(CASH_RECEIPT), ...reversedWithMirror(COMMISSION_ACCRUED),
    ]);
    expect(await trialBalanceNormalBalance(s)).toEqual(UNWOUND_TRIAL_BALANCE);
    expect(await bankBalanceMinor(s)).toBe(0);
    expect(await dealRows(d)).toMatchObject({ application: "CANCELLED", sale: "CANCELLED", vehicle: { status: "IN_INSPECTION" } });
  }, 30_000);

  async function closeCurrentPeriod(s: CashSeed) {
    const periodId = (await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId }))[0]._id;
    const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId });
    await s.owner.as.mutation(api.accountingPeriods.close, { orgId: s.orgId, periodId, acknowledgedWarnings: checklist.warnings });
    expect((await s.t.run((ctx) => ctx.db.get(periodId)))?.status).toBe("CLOSED");
  }

  test("U-RET period not open: the forward return and the finish refuse when today's period is closed, writing nothing", async () => {
    const d = await paidFinancedDealWithDeposit("s760periodclosed");
    const { s } = d;
    const unwindId = await startUnwind(d, "s760periodclosed-start");
    await closeCurrentPeriod(s);
    await expectRefusedAndUnchanged(s, () => returnForward(d, unwindId, "pc-1"), { code: "DEAL_UNWIND_PERIOD_NOT_OPEN" });
    expectLiteralRows(await journalRows(s), PAID_DEAL_ROWS);

    // Same for the finish, with the forward already returned while the period was open.
    const e = await paidFinancedDealWithDeposit("s760periodclosedb");
    const unwind2 = await startUnwind(e, "s760periodclosedb-start");
    await returnForward(e, unwind2, "s760periodclosedb-forward");
    await closeCurrentPeriod(e.s);
    await expectRefusedAndUnchanged(e.s, () => e.s.owner.as.mutation(api.dealUnwind.finishDealUnwind,
      finishArgsFor(e, unwind2, "pc-2")), { code: "DEAL_UNWIND_PERIOD_NOT_OPEN" });
    expectLiteralRows(await journalRows(e.s), FORWARD_RETURNED_ROWS);
    expect((await dealRows(e)).sale).toBe("COMPLETED");
  }, 30_000);

  test("CC period not open: a correction refuses COST_CORRECTION_NOT_POSTABLE_NOW when today's period is closed", async () => {
    const s = await costDealership("s760ccperiod");
    const vehicleId = await buyCar(s, "s760ccperiod", { method: "CASH" });
    await closeCurrentPeriod(s);
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId), { code: "COST_CORRECTION_NOT_POSTABLE_NOW" });
    expect((await costRows(s, vehicleId)).vehicle?.purchasePrice).toBe(12_500);
  }, 30_000);

  test("CC-UP: an upward CASH_REFUND correction pays the supplier more in cash, raising cost and inventory", async () => {
    const s = await costDealership("s760ccup");
    const vehicleId = await buyCar(s, "s760ccup", { method: "CASH" });
    await correct(s, vehicleId, { newCost: 13_000, reason: "Supplier invoice was for 13,000." });
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [...CAR_12500_CASH, J("1400", 500_000, 0), J("1100", 0, 500_000)]);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": -13_000_000, "1400|JOD": 13_000_000 });
    const after = await costRows(s, vehicleId);
    expect(after.vehicle?.purchasePrice).toBe(13_000);
    expect(after.cashbookCorrections).toHaveLength(1);
    expect(after.cashbookCorrections[0]).toMatchObject({ type: "OUT", amount: 500, category: "VEHICLE_PURCHASE" });
  }, 30_000);

  test("CC-BANK: a CASH_REFUND received into a bank moves that bank's balance; bank rules refuse without change", async () => {
    const s = await costDealership("s760ccbank");
    const vehicleId = await buyCar(s, "s760ccbank", { method: "CASH" });
    const bankId = await seedBank(s.t, s.orgId);
    await s.owner.as.mutation(api.bankAccounts.setReconciliationTarget, { orgId: s.orgId, bankAccountId: bankId });
    expect(await bankBalanceMinor(s)).toBe(0);
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { paymentMethod: "BANK_TRANSFER" }), { code: "COST_CORRECTION_BANK_INVALID" });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { paymentMethod: "CASH", bankAccountId: bankId }), {
      code: "COST_CORRECTION_BANK_NOT_APPLICABLE",
    });
    await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { paymentMethod: "CHEQUE" }), {
      code: "COST_CORRECTION_HELD_CHEQUE_UNSUPPORTED",
    });
    await correct(s, vehicleId, { paymentMethod: "BANK_TRANSFER", bankAccountId: bankId });
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [...CAR_12500_CASH, J("1110", 2_700_000, 0), J("1400", 0, 2_700_000)]);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": -12_500_000, "1110|JOD": 2_700_000, "1400|JOD": 9_800_000 });
    // The bank dimension: the refund lands on the named bank and its book balance reads it.
    expect(await bankBalanceMinor(s)).toBe(2_700_000);
    expect((await costRows(s, vehicleId)).corrections[0]).toMatchObject({ correctionType: "CASH_REFUND", bankAccountId: bankId });
  }, 30_000);

  test("CC-AP VENDOR_CREDIT lowers the payable and cost; a partly paid payable refuses both AP types", async () => {
    const s = await costDealership("s760ccvendor");
    const vehicleId = await buyCar(s, "s760ccvendor", { method: "ON_ACCOUNT" });
    await correct(s, vehicleId, { newCost: 11_000, correctionType: "VENDOR_CREDIT", paymentMethod: undefined });
    const rows = await journalRows(s);
    expectOracleRejectsEveryMutant(rows, [
      J("1400", 12_500_000, 0), J("2400", 0, 12_500_000), J("2400", 1_500_000, 0), J("1400", 0, 1_500_000),
    ]);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1400|JOD": 11_000_000, "2400|JOD": 11_000_000 });
    const after = await costRows(s, vehicleId);
    expect(after.vehicle?.purchasePrice).toBe(11_000);
    expect(after.payables).toMatchObject([{ amountDue: 11_000, status: "PENDING" }]);

    // Pay 1,000 of it: the invoice is no longer adjustable automatically.
    const bankId = await seedBank(s.t, s.orgId);
    await s.owner.as.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: "s760ccvendor-pay", orgId: s.orgId, payableId: after.payables[0]._id, amount: 1_000,
      paymentMethod: "BANK_TRANSFER", bankAccountId: bankId,
    });
    for (const correctionType of ["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT"] as const) {
      await expectRefusedAndUnchanged(s, () => correct(s, vehicleId, { newCost: 10_000, correctionType, paymentMethod: undefined }), {
        code: "COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE",
      });
    }
  }, 30_000);
});

// ─── SCRUM-854: no second SALE commission for the salesperson ────────────────
//
// Owner-ruling derivation (oracle: "Deal commission lines"). The salesperson's own
// sale commission is the one set on the sale row (paid by payroll). A SALE line for
// the same person would pay one role twice, so it is refused. Expected amounts are
// literals: 250,000 JOD minor on the sale row, 40,000 SALE line for another
// employee, 30,000 PURCHASE and 20,000 EXECUTION lines for the salesperson.
describe("SCRUM-854 deal commission lines: the salesperson is refused a second SALE line in the cases run (250, 1 and 5 against a 250 sale commission) (harness only)", () => {
  test("SALE line for the sale's own salesperson is refused with nothing written; other employee SALE and the salesperson's PURCHASE/EXECUTION are allowed; a second organization's rows never move", async () => {
    const d = await paidFinancedDealWithDeposit("s854dup");
    const { s, saleId } = d;
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    const salespersonId = sale!.salespersonId;
    const otherEmployeeId = s.actors.salesperson.userId;
    expect(sale!.orgId).toBe(s.orgId);
    expect(otherEmployeeId).not.toBe(salespersonId);
    await s.t.run(async (ctx) => {
      const m = await ctx.db.query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", s.orgId).eq("userId", otherEmployeeId)).unique();
      expect(m).not.toBeNull();
    });

    // A second organization with its own sale (copied from this one, different commission and
    // salesperson) and its own commission lines, so an unscoped scan or total would see foreign rows.
    const other = await authorizedOtherTenant(s, "s854dup");
    const foreign = await s.t.run(async (ctx) => {
      const foreignUser = await ctx.db.query("users").withIndex("by_clerkId", (q) => q.eq("clerkId", "s854dup_other_owner")).unique();
      const { _id: _i, _creationTime: _c, ...saleRow } = (await ctx.db.get(saleId))!;
      const foreignSaleId = await ctx.db.insert("sales", {
        ...saleRow, orgId: other.orgId, salespersonId: foreignUser!._id, commissionAmount: 999,
      });
      const line = (kind: "SALE" | "PURCHASE", employeeId: typeof salespersonId, amountMinor: number) =>
        ctx.db.insert("dealCommissionLines", {
          orgId: other.orgId, saleId: foreignSaleId, kind, employeeId, amountMinor, currency: "JOD", createdBy: foreignUser!._id,
        });
      // A SALE line for the foreign sale's own (different) salesperson, one for THIS org's salesperson
      // id, and a PURCHASE line.
      await line("SALE", foreignUser!._id, 7_000);
      await line("SALE", salespersonId, 8_000);
      await line("PURCHASE", foreignUser!._id, 9_000);
      return { foreignSaleId, foreignUserId: foreignUser!._id };
    });

    // Commission-line scans go through by_org_sale and assert the organization of every returned row:
    // scopedRows(orgId, saleId) is organization-and-sale scoped, scopedRows(orgId) is organization-only.
    // Two reads are deliberately different: the unscoped dealCommissionLines count below, and the
    // refusal snapshots (expectRefusedAndUnchanged), which compare every schema table across organizations.
    const scopedRows = async (orgId: typeof s.orgId, scanSaleId?: typeof saleId) => {
      const rows = await s.t.run(async (ctx) => ctx.db.query("dealCommissionLines")
        .withIndex("by_org_sale", (q) => scanSaleId === undefined ? q.eq("orgId", orgId) : q.eq("orgId", orgId).eq("saleId", scanSaleId))
        .collect());
      for (const r of rows) expect(r.orgId).toBe(orgId);
      return rows.map((r) => ({ orgId: r.orgId, saleId: r.saleId, kind: r.kind, employeeId: r.employeeId, amountMinor: r.amountMinor, removed: r.removedAt !== undefined }));
    };
    const foreignRows = () => scopedRows(other.orgId);
    const foreignBefore = await foreignRows();
    expect(foreignBefore).toHaveLength(3);
    expect(foreignBefore.map((r) => [r.kind, r.employeeId, r.amountMinor])).toEqual([
      ["SALE", foreign.foreignUserId, 7_000], ["SALE", salespersonId, 8_000], ["PURCHASE", foreign.foreignUserId, 9_000],
    ]);
    // The unscoped table does hold the foreign rows, so a scan that forgot the organization would be wrong.
    expect(await s.t.run(async (ctx) => (await ctx.db.query("dealCommissionLines").collect()).length)).toBe(3);

    // The payable total read through forSale, proved against an organization-and-sale-scoped recomputation.
    const readTotal = async () => {
      const view = await s.owner.as.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId });
      const saleNow = await s.t.run((ctx) => ctx.db.get(saleId));
      expect(saleNow!.orgId).toBe(s.orgId);
      const recomputed = Math.round(saleNow!.commissionAmount! * 1000)
        + (await scopedRows(s.orgId, saleId)).filter((r) => !r.removed).reduce((sum, r) => sum + r.amountMinor, 0);
      expect(view.totalMinor).toBe(recomputed);
      return { totalMinor: view.totalMinor, saleCommissionMinor: view.salesperson.amountMinor, lines: view.lines.length };
    };
    const expectForeignUntouched = async () => {
      expect(await foreignRows()).toEqual(foreignBefore);
      // Foreign total literal: 999 sale-row commission plus 7,000 + 8,000 + 9,000.
      const view = await other.owner.query(api.dealCommissions.forSale, { orgId: other.orgId, saleId: foreign.foreignSaleId });
      expect(view.totalMinor).toBe(999_000 + 24_000);
    };

    // Before: only the 250,000 sale-row commission exists in this org; no line rows at all.
    expect(await scopedRows(s.orgId)).toHaveLength(0);
    expect(await scopedRows(s.orgId, saleId)).toHaveLength(0);
    expect(await readTotal()).toEqual({ totalMinor: 250_000, saleCommissionMinor: 250_000, lines: 0 });

    // The duplicate SALE line is refused (amounts 250 and 1 run here), and every table is unchanged.
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "SALE", employeeId: salespersonId, amount: 250,
    }), { code: "DEAL_COMMISSION_LINE_DUPLICATES_SALESPERSON" });
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "SALE", employeeId: salespersonId, amount: 1,
    }), { code: "DEAL_COMMISSION_LINE_DUPLICATES_SALESPERSON" });
    expect(await scopedRows(s.orgId)).toHaveLength(0);
    expect(await scopedRows(s.orgId, saleId)).toHaveLength(0);
    expect(await readTotal()).toEqual({ totalMinor: 250_000, saleCommissionMinor: 250_000, lines: 0 });
    await expectForeignUntouched();

    // Allowed: SALE for another employee, PURCHASE and EXECUTION for the salesperson.
    await s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "SALE", employeeId: otherEmployeeId, amount: 40,
    });
    await s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "PURCHASE", employeeId: salespersonId, amount: 30,
    });
    await s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "EXECUTION", employeeId: salespersonId, amount: 20,
    });
    const rows = await scopedRows(s.orgId, saleId);
    expect(rows).toHaveLength(3);
    expect(await scopedRows(s.orgId)).toHaveLength(3);
    expect(rows.every((r) => r.orgId === s.orgId && r.saleId === saleId && !r.removed)).toBe(true);
    expect(rows.map((r) => [r.kind, r.employeeId, r.amountMinor])).toEqual([
      ["SALE", otherEmployeeId, 40_000], ["PURCHASE", salespersonId, 30_000], ["EXECUTION", salespersonId, 20_000],
    ]);
    // 250,000 + 40,000 + 30,000 + 20,000: the salesperson's SALE role is paid once.
    expect(await readTotal()).toEqual({ totalMinor: 340_000, saleCommissionMinor: 250_000, lines: 3 });
    await expectForeignUntouched();

    // The duplicate (amount 5 here) is still refused once other lines exist, and changes nothing.
    await expectRefusedAndUnchanged(s, () => s.owner.as.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId, kind: "SALE", employeeId: salespersonId, amount: 5,
    }), { code: "DEAL_COMMISSION_LINE_DUPLICATES_SALESPERSON" });
    expect(await scopedRows(s.orgId, saleId)).toEqual(rows);
    expect(await readTotal()).toEqual({ totalMinor: 340_000, saleCommissionMinor: 250_000, lines: 3 });
    await expectForeignUntouched();
  }, 30_000);
});
