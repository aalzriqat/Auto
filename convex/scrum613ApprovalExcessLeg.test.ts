/**
 * SCRUM-613 (approval excess posting leg): when F + P exceeds the approved value A, the part above A is the
 * dealer's income (revenue 4100 = A + R + E) and the finance company is paid A - F - direct = H - E, not H + D.
 *
 * Every expected figure is a literal worked by hand from the owner rulings (SCRUM-613 comments 25968 and 25987)
 * and the fixture - never read back from the code under test:
 *   A = 12,500,000 approved value, F = 11,000,000 approved financing, P = 1,740,000 customer first payment,
 *   E = F + P - A = 240,000, D = 0, vehicle cost 9,000,000 (JOD, minor units x1000).
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime and not production data.
 */
import { describe, expect, test, vi } from "vitest";
import {
  finalizeAsOwner, insertReceiptBank, payForwardAsOwner, readyDeal, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { registerHandover } from "../test-utils/convexTest";
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
  "create:sales", "view:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "approve:requests", "view:finance_applications",
  "create:finance_application", "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
  "manage:finance", "view:finance", "view:commissions", "manage:commissions", "view:reports", "manage:settings",
  "view:cost_price",
];

const A = 12_500_000;
const F = 11_000_000;
const P = 1_740_000;
const E = 240_000;
const COST = 9_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface DealOptions {
  /** Held deposit rows H, in minor units (default: all of P). */
  heldMinor?: number;
  /** Confirmed direct payment to the finance company, in minor units. */
  directMinor?: number;
  financingMinor?: number;
  sourced?: boolean;
  /** After the handover, shrink the held deposit row to this (the first payment is then unproven). */
  shrinkHeldToMinor?: number;
}

/** A deal driven through the real mutations to the point where it can be paid forward and finalized. */
async function excessDeal(tag: string, o: DealOptions = {}) {
  const heldMinor = o.heldMinor ?? P;
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: PERMS, label: "S613L", vinPrefix: "VIN613L", actors: {}, sourced: o.sourced ?? false,
  });
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId, customerEligibilityStatusIds: [s.customerStatusId],
    vehiclePrice: A / 1000, downPayment: P / 1000, totalFinancedAmount: (A - P) / 1000, termMonths: 48,
  });
  const depositId = await s.owner.as.mutation(api.deposits.create, {
    orgId: s.orgId, quoteId, amount: heldMinor / 1000, method: "CASH", idempotencyKey: `s613-deposit-${tag}`,
  });
  const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: A, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: A, approvedFinancingAmountMinor: o.financingMinor ?? F,
    basis: "MANUAL", notes: "Approval above the approved value.",
  });
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  if (o.directMinor) {
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
      orgId: s.orgId, applicationId, amountMinor: o.directMinor, paidAt: Date.now(),
      reference: "Direct lender receipt", kind: "RECEIPT", idempotencyKey: `s613-direct-${tag}`,
    });
  }
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  if (o.shrinkHeldToMinor !== undefined) {
    // The proof that satisfied the handover is gone: P is more than the deposit rows plus confirmed direct payments.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(depositId, { amount: o.shrinkHeldToMinor! / 1000, amountMinor: o.shrinkHeldToMinor });
      await ctx.db.patch(applicationId, { firstPaymentEvidenceChecked: undefined });
    });
  }
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: `s613-fee-${tag}`, orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  return { s, applicationId, quoteId, depositId };
}
type Seeded = Awaited<ReturnType<typeof excessDeal>>["s"];

const appOf = (s: Seeded, id: Id<"financeApplications">) => s.t.run((ctx) => ctx.db.get(id));

async function journalRows(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const status = new Map(entries.map((entry) => [entry._id, entry.status]));
    const lines = await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return await Promise.all(lines.map(async (line) => ({
      account: (await ctx.db.get(line.accountId))?.code,
      currency: line.currency,
      debit: line.debitMinor,
      credit: line.creditMinor,
      entryStatus: status.get(line.journalEntryId),
    })));
  });
}
type Row = Awaited<ReturnType<typeof journalRows>>[number];
const row = (account: string, debit: number, credit: number): Row => ({
  account, currency: "JOD", debit, credit, entryStatus: "POSTED",
});
function expectLiteralRows(actual: Row[], expected: Row[]) {
  const key = (r: Row) => [r.account ?? "", String(r.debit).padStart(12, "0"), String(r.credit).padStart(12, "0"), r.entryStatus].join("|");
  const order = (a: Row, b: Row) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  expect([...actual].sort(order)).toEqual([...expected].sort(order));
  expect(actual.reduce((total, r) => total + r.debit - r.credit, 0)).toBe(0);
}

/** Row counts of every table a money door could write, to prove "nothing was written". */
async function writes(s: Seeded) {
  return await s.t.run(async (ctx) => ({
    forwards: (await ctx.db.query("financeCompanyForwards").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    sales: (await ctx.db.query("sales").collect()).length,
  }));
}

async function forwardArgs(s: Seeded, applicationId: Id<"financeApplications">, expectedAmountMinor: number, key = "fwd") {
  return {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER" as const, bankAccountId: await seedBank(s.t, s.orgId),
    paidAt: Date.now(), expectedAmountMinor, reference: "S613-FORWARD", idempotencyKey: `s613-${key}-${applicationId}`,
  };
}

/** The deal rows of a financed sale that closed with the excess, held in full: A 12,500,000, H 1,740,000. */
const heldExcessRows = (forward: number): Row[] => [
  row("1100", P, 0), row("2100", 0, P), // the customer's first payment is held (receipt)
  row("1210", A, 0), // the finance company owes the approved value
  row("2100", P, 0), // the held payment is released to the sale
  row("4100", 0, A), // vehicle revenue at the approved value
  row("4100", 0, E), // the approval excess is dealer income
  row("2220", 0, forward), // owed to the finance company: A - F, i.e. H - E
  row("5100", COST, 0), row("1400", 0, COST), // cost of the vehicle
  row("2220", forward, 0), row("1110", 0, forward), // the forward payment, paid before the sale
];

describe("SCRUM-613 approval excess: held first payment (all of P with the dealer)", () => {
  test("the approval stores E = F + P - A and no contribution", async () => {
    const { s, applicationId } = await excessDeal("derive");
    expect(await appOf(s, applicationId)).toMatchObject({
      approvedFinancingAmountMinor: F, customerFirstPaymentMinor: P, approvalExcessMinor: E, dealerContributionMinor: 0,
    });
  });

  test("forward then finalize: the finance company is paid H - E = A - F, and the sale credits E to revenue 4100", async () => {
    const { s, applicationId, depositId } = await excessDeal("held");
    // The forward is A - F (1,500,000), not H + D (1,740,000).
    const refused = await refusalDataOf(s.owner.as.mutation(
      api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, P, "wrong"),
    ));
    expect(refused?.code).not.toBe("APPROVAL_EXCESS_NOT_POSTABLE");
    expect(await writes(s)).toMatchObject({ forwards: 0 });
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F));
    await finalizeAsOwner(s, applicationId, { payForward: false });

    const app = await appOf(s, applicationId);
    expect(app).toMatchObject({
      status: "CLOSED", financeCompanyForwardDueMinor: 1_500_000, forwardDepositPortionMinor: 1_500_000,
      forwardContributionPortionMinor: 0, approvalExcessMinor: E,
    });
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("APPLIED");
    expectLiteralRows(await journalRows(s), heldExcessRows(1_500_000));
    const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
    // Frozen net revenue = A + R + E - D = 12,740,000.
    expect(sale?.financedNetRevenue?.minor).toBe(12_740_000);
  });

  test("the forward is re-recorded after a reversal (finalize then forward): the same literal rows", async () => {
    const { s, applicationId } = await excessDeal("order2");
    const forwardId = await s.owner.as.mutation(
      api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F, "first"),
    );
    await finalizeAsOwner(s, applicationId, { payForward: false });
    await s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: `s613-rev-${applicationId}`,
    });
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F, "second"));
    const rows = await journalRows(s);
    const payments = rows.filter((r) => r.account === "1110");
    expect(payments.map((r) => [r.credit, r.debit]).sort()).toEqual([[0, 1_500_000], [1_500_000, 0], [1_500_000, 0]].sort());
    const net2220 = rows.filter((r) => r.account === "2220").reduce((total, r) => total + r.credit - r.debit, 0);
    expect(net2220).toBe(0);
    expect(rows.filter((r) => r.account === "4100").map((r) => r.credit).sort((a, b) => a - b)).toEqual([E, A]);
  });

  test("editing E while the forward is on the books is refused and nothing changes", async () => {
    const { s, applicationId } = await excessDeal("editE");
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F));
    // A bigger approved financing moves E (340,000) while D stays 0: the amount paid forward would be stale.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { approvedFinancingAmountMinor: F + 100_000 }));
    const before = await appOf(s, applicationId);
    const feeId = s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", orgId: s.orgId, applicationId, feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER",
      paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: true, actualAmountMinor: 0,
      description: "Drives the recompute", idempotencyKey: `s613-drive-${applicationId}`,
    });
    const refusal = await refusalDataOf(feeId);
    expect(refusal?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
    expect((await appOf(s, applicationId))?.approvalExcessMinor).toBe(before?.approvalExcessMinor);
  });
});

describe("SCRUM-613 approval excess: part of P paid directly to the finance company", () => {
  test("H 1,000,000 held and 740,000 confirmed direct: forward = H - E = 760,000, E to revenue 4100", async () => {
    const { s, applicationId } = await excessDeal("direct", { heldMinor: 1_000_000, directMinor: 740_000 });
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, 760_000));
    await finalizeAsOwner(s, applicationId, { payForward: false });
    expectLiteralRows(await journalRows(s), [
      row("1100", 1_000_000, 0), row("2100", 0, 1_000_000),
      row("1210", A, 0), row("2100", 1_000_000, 0),
      row("4100", 0, A), row("4100", 0, E),
      row("2220", 0, 760_000),
      row("5100", COST, 0), row("1400", 0, COST),
      row("2220", 760_000, 0), row("1110", 0, 760_000),
    ]);
    expect((await appOf(s, applicationId))?.financeCompanyForwardDueMinor).toBe(760_000);
  });
});

describe("SCRUM-613 approval excess: five readers agree on the deal's revenue and profit", () => {
  async function readAll(s: Seeded, applicationId: Id<"financeApplications">) {
    const window = { startDate: Date.now() - 30 * DAY, endDate: Date.now() + DAY };
    const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...window });
    const pnl = await s.owner.as.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...window });
    const dashboard = await s.owner.as.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });
    const overview = await s.owner.as.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const income = await s.owner.as.query(api.accountingReports.incomeStatement, {
      orgId: s.orgId, fromDate: Date.UTC(s.fiscalYear, 0, 1), toDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
    });
    const app = await appOf(s, applicationId);
    const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
    return { report, pnl, dashboard, overview, income, sale };
  }

  test("excess deal: journal, frozen net, sales report, P&L, deal page and dashboard all say revenue 12,740,000 and profit 3,740,000", async () => {
    const { s, applicationId } = await excessDeal("five");
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F));
    await finalizeAsOwner(s, applicationId, { payForward: false });
    const r = await readAll(s, applicationId);
    // (i) the journal: 4100 net of 4180, less cost of sales
    expect(r.income).toMatchObject({ totalRevenue: 12_740_000, totalCogs: COST, grossProfit: 3_740_000 });
    // (ii) the frozen net revenue on the sale
    expect(r.sale?.financedNetRevenue?.minor).toBe(12_740_000);
    // (iii) the report queries (major units)
    const line = r.report?.sales[0];
    expect(line?.recognizedRevenue).toBe(12_740);
    expect(line?.netProfit).toBe(3_740);
    expect(r.report?.totalRevenue).toBe(12_740);
    expect(r.report?.totalProfit).toBe(3_740);
    expect(r.pnl?.totalRevenue).toBe(12_740);
    // (iv) the deal page management profit
    expect(r.overview?.financialSummary?.profit).toMatchObject({ available: true, amountMinor: 3_740_000 });
    // (v) the dashboard figure
    expect(r.dashboard.salesVolumeThisMonth).toBe(12_740);
  });

  test("control, no excess: the same five readers are unchanged (revenue 11,125,000, profit 2,125,000)", async () => {
    const s = await seedFinancedDealership("fivectl", {
      modules: MODULES, ownerPerms: PERMS, label: "S613L", vinPrefix: "VIN613L", actors: {},
    });
    const { applicationId } = await readyDeal(s);
    await finalizeAsOwner(s, applicationId);
    const r = await readAll(s, applicationId);
    expect(r.income).toMatchObject({ totalRevenue: 11_125_000, totalCogs: COST, grossProfit: 2_125_000 });
    expect(r.sale?.financedNetRevenue?.minor).toBe(11_125_000);
    expect(r.report?.sales[0]?.recognizedRevenue).toBe(11_125);
    expect(r.report?.sales[0]?.netProfit).toBe(2_125);
    expect(r.pnl?.totalRevenue).toBe(11_125);
    expect(r.overview?.financialSummary?.profit).toMatchObject({ available: true, amountMinor: 2_125_000 });
    expect(r.dashboard.salesVolumeThisMonth).toBe(11_125);
  });
});

describe("SCRUM-613 approval excess: unsupported shapes refuse with a coded reason before any write", () => {
  const doors = async (s: Seeded, applicationId: Id<"financeApplications">) => ({
    forward: await refusalDataOf(s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F))),
    finalize: await refusalDataOf(s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey: `s613-fin-${applicationId}`, orgId: s.orgId, applicationId })),
    readiness: await s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId }),
  });

  test("P above the held deposit with no confirmed direct payment refuses with EXCESS_FIRST_PAYMENT_UNPROVEN and writes nothing", async () => {
    const { s, applicationId } = await excessDeal("unproven", { shrinkHeldToMinor: 1_000_000 });
    const before = await writes(s);
    const d = await doors(s, applicationId);
    expect(d.forward?.code).toBe("EXCESS_FIRST_PAYMENT_UNPROVEN");
    expect(d.finalize?.code).toBe("EXCESS_FIRST_PAYMENT_UNPROVEN");
    expect(d.readiness).toMatchObject({ state: "UNAVAILABLE", unavailableReasonCode: "EXCESS_FIRST_PAYMENT_UNPROVEN" });
    expect(await writes(s)).toEqual(before);
  });

  test("a held deposit smaller than the excess refuses with EXCESS_EXCEEDS_HELD_DEPOSIT and writes nothing", async () => {
    // P is all direct (nothing held): H = 0 < E.
    const { s, applicationId } = await excessDeal("belowE", { heldMinor: 100_000, directMinor: 1_640_000 });
    const before = await writes(s);
    const d = await doors(s, applicationId);
    expect(d.forward?.code).toBe("EXCESS_EXCEEDS_HELD_DEPOSIT");
    expect(d.finalize?.code).toBe("EXCESS_EXCEEDS_HELD_DEPOSIT");
    expect(await writes(s)).toEqual(before);
  });

  test("a consigned (SOURCED) vehicle refuses with EXCESS_SHAPE_UNSUPPORTED and writes nothing", async () => {
    const { s, applicationId } = await excessDeal("sourced", { sourced: true });
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP" });
    const before = await writes(s);
    const d = await doors(s, applicationId);
    expect(d.forward?.code).toBe("EXCESS_SHAPE_UNSUPPORTED");
    expect(d.finalize?.code).toBe("EXCESS_SHAPE_UNSUPPORTED");
    expect(await writes(s)).toEqual(before);
  });

  test("the refusal text no longer promises a correction of the approved financing amount", async () => {
    const { s, applicationId } = await excessDeal("text", { sourced: true });
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP" });
    const d = await doors(s, applicationId);
    expect(d.finalize?.message).not.toMatch(/until the approved financing amount is corrected/i);
  });
});

describe("SCRUM-613 approval excess: unwinding the closed deal", () => {
  test("the unwind takes back the sale, the excess income and the forward: every deal account nets to zero except the held payment", async () => {
    const { s, applicationId } = await excessDeal("unwind");
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, await forwardArgs(s, applicationId, A - F));
    await finalizeAsOwner(s, applicationId, { payForward: false });
    await s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: A, idempotencyKey: "s613-unwind-disburse",
      bankAccountId: await insertReceiptBank(s),
    });
    const unwindId = await s.owner.as.mutation(api.dealUnwind.startDealUnwind, {
      orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: "s613-unwind-start",
    });
    await s.owner.as.mutation(api.dealUnwind.recordDealUnwindForwardReturn, {
      orgId: s.orgId, unwindId, returnedAt: Date.now(), reference: "FC-RET-613", idempotencyKey: "s613-unwind-return",
    });
    await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, {
      orgId: s.orgId, unwindId, method: "BANK_TRANSFER", refundedAt: Date.now(), bankReference: "TRF-613",
      creditNoteReference: "CN-613", vehicleReturnedAt: Date.now(), vehicleReturnNote: "Returned to the lot.",
      customerPaymentDisposition: "RETAIN_CREDIT", idempotencyKey: "s613-unwind-finish",
    });
    // Originals turn REVERSED and their reversals POSTED, so all of them are summed.
    const rows = await journalRows(s);
    const net = (account: string) =>
      rows.filter((r) => r.account === account).reduce((total, r) => total + r.debit - r.credit, 0);
    // Literal nets: the excess income (4100 credit 240,000) is reversed with the sale, and the forward is returned.
    expect(["4100", "1210", "2220", "1110", "5100", "1400"].map(net)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rows.reduce((total, r) => total + r.debit - r.credit, 0)).toBe(0);
  });
});

describe("SCRUM-613 no-excess deals are byte-identical", () => {
  test("a deal with no excess keeps its plan fingerprint, forward and journal (no excess token, no extra 4100 line)", async () => {
    const s = await seedFinancedDealership("ident", {
      modules: MODULES, ownerPerms: PERMS, label: "S613L", vinPrefix: "VIN613L", actors: {},
    });
    const { applicationId } = await readyDeal(s);
    await payForwardAsOwner(s, applicationId);
    await finalizeAsOwner(s, applicationId, { payForward: false });
    const app = await appOf(s, applicationId);
    // The v3 fingerprint of the fixture deal worked by hand: K 12,500,000, G 12,500,000, forward 1,575,000,
    // deposit 200,000, contribution 1,375,000, F-less legacy fixture shape.
    expect(app?.financedSaleRecognitionFingerprint).toBe("v3;JOD;K12500000;G12500000;F1575000;D200000;C1375000;R0");
    expect(app?.approvalExcessMinor ?? 0).toBe(0);
    expect(app?.financeCompanyForwardDueMinor).toBe(1_575_000);
    const rows = await journalRows(s);
    expect(rows.filter((r) => r.account === "4100")).toEqual([row("4100", 0, A)]);
    expect(rows.filter((r) => r.account === "4180")).toEqual([row("4180", 1_375_000, 0)]);
  });
});
