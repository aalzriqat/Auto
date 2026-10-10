/**
 * SCRUM-486: literal, independent certification rows driven through public money doors.
 *
 * These harness rows cover only selected owned CASH and retired-mode paths.
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
import { api } from "./_generated/api";
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

async function eventStatuses(s: CashSeed, eventType: string, sourceId: string) {
  return await s.t.run(async (ctx) => (
    await ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
      q.eq("orgId", s.orgId).eq("sourceType", eventType === "SALE_COMPLETED" ? "sales" : "deposits").eq("sourceId", sourceId)
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
  const toDate = Math.max(...periods.map((period) => period.endDate));
  const report = await s.owner.as.query(api.accountingReports.trialBalance, { orgId: s.orgId, toDate });
  expect(report.isBalanced).toBe(true);
  return Object.fromEntries(report.rows
    .filter((row) => row.netMinor !== 0)
    .map((row) => [`${row.code}|${row.currency}`, row.netMinor] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

describe("SCRUM-486 literal certification matrix (harness only)", () => {
  test("owned configured financier × held 200 first payment: contribution, forward, partial refusal and full receipt", async () => {
    const s = await seedFinancedDealership("s486financedheld", {
      modules: MODULES,
      ownerPerms: OWNER_PERMS,
      actors: {},
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
    await s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId, applicationId, legalInvoiceAmountMinor: 12_500_000,
      legalInvoiceNumber: `CERT-${applicationId}`, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: "s486-financed-held-zero-fee", orgId: s.orgId, applicationId,
      feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
      actualAmountMinor: 0, description: "No closing costs.",
    });
    await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "No fee to settle.",
    });
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
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 200_000,
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "2220|JOD": 1_575_000,
      "4100|JOD": 12_500_000,
      "4180|JOD": -1_375_000,
      "5100|JOD": 10_000_000,
    });

    const paidAt = Date.now();
    const forwardArgs = {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER" as const, paidAt,
      expectedAmountMinor: 1_575_000, reference: "CERT-FORWARD",
      idempotencyKey: "s486-financed-held-forward",
    };
    await s.approver.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, forwardArgs);
    const afterForward = await journalRows(s);
    expectAdditionalRows(rows, afterForward, [
      { account: "2220", currency: "JOD", debit: 1_575_000, credit: 0, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 0, credit: 1_575_000, entryStatus: "POSTED" },
    ]);
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
  });

  test("owned configured financier × no deposit: full approved amount is company AR, not customer AR", async () => {
    const s = await seedFinancedDealership("s486financednone", {
      modules: MODULES,
      ownerPerms: OWNER_PERMS,
      actors: {},
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
    await s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId, applicationId, legalInvoiceAmountMinor: 12_500_000,
      legalInvoiceNumber: `CERT-${applicationId}`, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: "s486-financed-zero-fee", orgId: s.orgId, applicationId,
      feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
      actualAmountMinor: 0, description: "No closing costs.",
    });
    await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "No fee to settle.",
    });
    await s.owner.as.mutation(api.applications.finalizeDeal, {
      idempotencyKey: "s486-financed-finalize", orgId: s.orgId, applicationId,
    });

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
    // The customer may remain on the document for deal provenance; payerType and
    // financeCompanyId identify who legally owes this invoice.
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "5100|JOD": 10_000_000,
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
      })).rejects.toThrow();
      expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
      await expect(salesperson.mutation(api.deposits.release, {
        orgId: s.orgId,
        depositId,
        resolution,
        ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
        idempotencyKey: `scrum486-salesperson-${resolution.toLowerCase()}-denied`,
      })).rejects.toThrow();
      expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
      expect(netByAccount(await journalRows(s))).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });
    },
  );

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
