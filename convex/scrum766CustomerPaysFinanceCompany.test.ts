/**
 * SCRUM-766 PR-B, the ledger half: when the customer pays the finance company
 * directly toward the net shortfall, the showroom forwards (and the sale
 * recognises) a contribution reduced by exactly that payment - but only once the
 * payment is CONFIRMED by a recorded evidence row.
 *
 * Hand-computed deal, JOD minor units (scale 1,000), company at 85% LTV:
 *   quoted 12,500, customer first payment 500   -> showroom contribution 1,375
 *   approved 11,500: funded 9,775, first payment 500, contribution 1,225
 *   net shortfall = (12,500 - 1,375) - (11,500 - 1,225) = 850
 *   customer agrees to pay 400 to the finance company, showroom covers 450
 *   agreed only    -> contribution stays 1,225 (a promise is not money)
 *   confirmed 400  -> contribution 1,225 - 400 = 825
 *   -> sale revenue 11,500 (approved; the 400 never touched the dealership's books)
 *   -> consideration reduction 825, payable to the finance company 825.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { finalizeAsOwner, newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { deriveManagementProfit } from "./utils/financingEconomics";
import { FORWARD_VERSIONS_ONLY, deriveForwardState, forwardPostKey } from "./utils/financeCompanyForward";

// SCRUM-571 financed-gap-collection opt-out: fixture only, policy and allowed list in scripts/scrum571FinancedGapOptOutCensus.test.ts.
vi.mock("./utils/financedGapPilotSwitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/financedGapPilotSwitch")>()),
  FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED: false,
}));
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

async function seed(tag: string, opts: { sourced?: boolean } = {}) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S766B", vinPrefix: "VIN766B",
    // Can read the deal and its figures but holds no finance-disbursement authority.
    actors: { Clerk: ["view:sales", "view:finance_applications", "view:finance"] },
    ...opts,
  });
  // The fixture company lends 100%, which leaves the showroom nothing to contribute.
  await s.t.run((ctx) => ctx.db.patch(s.companyId, { defaultLtvPercent: 85 }));
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * Debit-positive net per system account across the live events of one type (as the scrum411
 * suites' helper of the same name): SALE_COMPLETED alone is what the sale recognises, without
 * the showroom's earlier payment to the finance company.
 */
async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net: Record<string, number> = {};
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
          net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
        }
      }
    }
    return net;
  });
}

/** Debit-positive net per system account across every journal line in the org. */
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

async function appOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

/** Records the customer's payment to the finance company as confirmed evidence, as the approver. */
function confirmPayment(s: Seeded, applicationId: Id<"financeApplications">, amount: number, reference = "TRF-766") {
  return s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
    orgId: s.orgId, applicationId, amountMinor: jod(amount), paidAt: Date.now() - 1_000, reference,
    idempotencyKey: crypto.randomUUID(),
  });
}

/** Every evidence row on a deal, voided ones included. */
async function rowsOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) =>
    ctx.db
      .query("customerFinanceCompanyPayments")
      .withIndex("by_org_application", (q) => q.eq("orgId", s.orgId).eq("applicationId", applicationId))
      .take(100)
  );
}

/** The closing-readiness verdict for the customer-payment check, as the deal screen is served it. */
async function paymentCheckOf(s: Seeded, applicationId: Id<"financeApplications">) {
  const served = await s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
  const check = served.checks.find((c) => c.key === "CUSTOMER_FINANCE_COMPANY_PAYMENT_CONFIRMED");
  expect(check).toBeDefined();
  return check!;
}

function listPayments(s: Seeded, applicationId: Id<"financeApplications">) {
  return s.approver.as.query(api.customerFinanceCompanyPayments.listPayments, { orgId: s.orgId, applicationId });
}

/** After handover only the settlement-cost writers recompute; a deducted fee drives one. */
async function driveRecompute(s: Seeded, applicationId: Id<"financeApplications">, n: number) {
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", orgId: s.orgId, applicationId, feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: true, actualAmountMinor: 0, description: `Fee ${n} (drives the recompute)`,
    idempotencyKey: `drive-recompute-${n}:${applicationId}`,
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
}

/** What a rejected call carried: the coded readiness reason, or just the message. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) return data as { code?: string; message: string };
    return { message: String(data ?? (error as Error).message) };
  }
  return null;
}

/**
 * The management profit the deal screen derives from the STORED contribution, in minor units.
 * The supplier settlement and expenses are held fixed (the fixture has neither), so a change
 * in the figure can only come from the contribution the engine stored.
 */
async function profitOf(s: Seeded, applicationId: Id<"financeApplications">): Promise<number> {
  const app = await appOf(s, applicationId);
  const profit = deriveManagementProfit({
    approvedDealerPurchaseAmountMinor: app?.approvedDealerPurchaseAmountMinor,
    supplierSettlementMinor: 0,
    dealerContributionMinor: app?.dealerContributionMinor,
    actualExpensesMinor: 0,
    currency: "JOD",
    fullySettled: true,
  });
  if (!profit.available) throw new Error(`profit unavailable: ${profit.reason}`);
  return profit.amountMinor;
}

type Split = { customer: number; dealer: number; cash: number; financeCompany: number };

/** Approved at 11,500 against a 12,500 quotation (shortfall 850); not yet agreed, not handed over. */
async function approvedDeal(s: Seeded) {
  const { applicationId } = await newApplication(s);
  const { owner, approver, orgId } = s;
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY",
    customerFirstPaymentMinor: jod(500),
  });
  await approveAt11500(s, applicationId);
  return applicationId;
}

async function approveAt11500(s: Seeded, applicationId: Id<"financeApplications">) {
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: jod(11_500), basis: "MANUAL", notes: "Approved below the quotation.",
  });
  const app = await appOf(s, applicationId);
  expect(app?.netShortfallMinor).toBe(jod(850));
  expect(app?.dealerContributionMinor).toBe(jod(1_225));
}

/** Records how the 850 shortfall is shared, as the approver. */
async function agree(s: Seeded, applicationId: Id<"financeApplications">, split: Split) {
  const served = await s.approver.as.query(api.applications.get, { orgId: s.orgId, applicationId });
  await s.approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
    orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp as string,
    customerGapShareMinor: jod(split.customer),
    dealerGapShareMinor: jod(split.dealer),
    customerGapCashToDealerMinor: jod(split.cash),
    customerGapInstallmentToDealerMinor: 0,
    customerGapToFinanceCompanyMinor: jod(split.financeCompany),
  });
}

/** Approved at 11,500 against a 12,500 quotation; shortfall 850, resolved as given, vehicle handed over. */
async function resolvedDeal(s: Seeded, split: Split) {
  const applicationId = await approvedDeal(s);
  await agree(s, applicationId, split);
  await handOver(s, applicationId);
  return applicationId;
}

/** Hands the vehicle over and reconciles the deal's closing costs: the rest of what a resolved deal needs. */
async function handOver(s: Seeded, applicationId: Id<"financeApplications">) {
  const { owner, orgId } = s;
  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  // No legal invoice: SCRUM-411 makes it optional evidence. The server derives the
  // consideration (approved amount + what the customer owes the DEALERSHIP) from the
  // agreed split, and the part paid to the finance company is not billed by the dealership.
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

const SPLIT_400_TO_COMPANY = { customer: 400, dealer: 450, cash: 0, financeCompany: 400 };

describe("SCRUM-766 PR-B: the customer pays part of the shortfall to the finance company, through finalize", () => {
  test("400 confirmed to the finance company: the sale forwards 825, not 1,225", async () => {
    const s = await seed("a");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    await confirmPayment(s, applicationId, 400);
    await finalizeAsOwner(s, applicationId);

    const app = await appOf(s, applicationId);
    expect(app?.dealerContributionMinor).toBe(jod(825));
    expect(app?.financeCompanyForwardDueMinor).toBe(jod(825));

    const gl = await glNet(s);
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_500));
    expect(gl.SALES_REVENUE).toBe(-jod(11_500));
    expect(gl.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(825));
    // The showroom paid 825 (not 1,225) before finalize (SCRUM-411 P2-01); the sale then
    // credits the same 825, so what is owed to the company nets to nothing.
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect((await netByAccount(s, "SALE_COMPLETED")).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
    const forwards = await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect());
    expect(forwards.map((row) => row.amountMinor)).toEqual([jod(825)]);
    // Nothing is owed to the dealership by the customer: the 400 is the company's.
    expect(gl.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBeUndefined();

    // The commissionable margin (approved - contribution - cost, SCRUM-390 OR-5) is
    // frozen on the contribution BEFORE the customer's payment (1,225, not 825).
    expect((await commissionBaseOf(s, applicationId))?.contributionMinor).toBe(jod(1_225));
  });

  test("the commissionable margin is the same wherever the customer's 400 goes (Batch 2 Q-A)", async () => {
    const toCompany = await seed("c1");
    const toCompanyApp = await resolvedDeal(toCompany, SPLIT_400_TO_COMPANY);
    await confirmPayment(toCompany, toCompanyApp, 400);
    await finalizeAsOwner(toCompany, toCompanyApp);
    const toDealer = await seed("c2");
    const toDealerApp = await resolvedDeal(toDealer, { customer: 400, dealer: 450, cash: 400, financeCompany: 0 });
    await finalizeAsOwner(toDealer, toDealerApp);

    // 11,500 approved, 1,225 contribution: identical whether the customer paid
    // the company or the dealership.
    const expected = { approvedMinor: jod(11_500), contributionMinor: jod(1_225), currency: "JOD" };
    expect(await commissionBaseOf(toCompany, toCompanyApp)).toEqual(expected);
    expect(await commissionBaseOf(toDealer, toDealerApp)).toEqual(expected);
    // While the ledger differs exactly by the forward the sale recognises: 825 to the company,
    // 1,225 when the dealership collects. Both were paid before finalize, so each nets to nothing.
    expect((await netByAccount(toCompany, "SALE_COMPLETED")).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
    expect((await netByAccount(toDealer, "SALE_COMPLETED")).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
    expect((await glNet(toCompany)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect((await glNet(toDealer)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
  });

  test("a mixed share: 200 cash to the dealership and 400 confirmed to the finance company", async () => {
    const s = await seed("b");
    const applicationId = await resolvedDeal(s, { customer: 600, dealer: 250, cash: 200, financeCompany: 400 });
    await confirmPayment(s, applicationId, 400);
    await finalizeAsOwner(s, applicationId);

    const gl = await glNet(s);
    // Revenue is the server-derived consideration: approved 11,500 + the 200 the customer owes us.
    expect(gl.SALES_REVENUE).toBe(-jod(11_700));
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_500));
    expect(gl.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBe(jod(200));
    expect(gl.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(825));
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect((await netByAccount(s, "SALE_COMPLETED")).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
  });
});

describe("SCRUM-766 PR-B: only CONFIRMED payment evidence reduces the contribution", () => {
  test("an agreement alone leaves the contribution and the profit unreduced, and closing is refused", async () => {
    const s = await seed("u1");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);

    // The customer has promised 400; nobody has seen it paid. The showroom still owes 1,225.
    const agreed = await appOf(s, applicationId);
    expect(agreed?.customerGapToFinanceCompanyMinor).toBe(jod(400));
    expect(agreed?.dealerContributionMinor).toBe(jod(1_225));
    expect(agreed?.customerGapToFinanceCompanyAppliedMinor ?? 0).toBe(0);
    const unconfirmedProfit = await profitOf(s, applicationId);

    const refusal = await refusalOf(finalizeAsOwner(s, applicationId));
    expect(refusal?.code).toBe("CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED");
    expect((await appOf(s, applicationId))?.finalizedSaleId).toBeUndefined();
    expect(await glNet(s)).toEqual({});

    // Confirming the payment is what moves the contribution and the profit, by exactly the 400.
    await confirmPayment(s, applicationId, 400);
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    expect(await profitOf(s, applicationId)).toBe(unconfirmedProfit + jod(400));
  });

  test("a partial confirmation credits only what is confirmed and still blocks closing", async () => {
    const s = await seed("u2");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    await confirmPayment(s, applicationId, 150, "TRF-1");

    const partial = await appOf(s, applicationId);
    expect(partial?.dealerContributionMinor).toBe(jod(1_075));
    expect(partial?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(150));
    expect((await refusalOf(finalizeAsOwner(s, applicationId)))?.code).toBe(
      "CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED"
    );

    await confirmPayment(s, applicationId, 250, "TRF-2");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    await finalizeAsOwner(s, applicationId);
    expect((await appOf(s, applicationId))?.financeCompanyForwardDueMinor).toBe(jod(825));
  });

  test("a payment cannot be confirmed beyond what was agreed, or where nothing was agreed", async () => {
    const s = await seed("u3");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    expect((await refusalOf(confirmPayment(s, applicationId, 401)))?.message).toContain(
      "more than the customer agreed to pay the finance company"
    );
    await confirmPayment(s, applicationId, 300, "TRF-1");
    // 100 remains unconfirmed; a second 300 would overpay the agreement.
    expect((await refusalOf(confirmPayment(s, applicationId, 300, "TRF-2")))?.message).toContain(
      "more than the customer agreed to pay the finance company"
    );
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(925));
    expect(await rowsOf(s, applicationId)).toHaveLength(1);

    const cashOnly = await seed("u3b");
    const cashApp = await resolvedDeal(cashOnly, { customer: 400, dealer: 450, cash: 400, financeCompany: 0 });
    expect((await refusalOf(confirmPayment(cashOnly, cashApp, 100)))?.message).toContain(
      "has not agreed to pay part of the shortfall to the finance company"
    );
    expect((await appOf(cashOnly, cashApp))?.dealerContributionMinor).toBe(jod(1_225));
    expect(await rowsOf(cashOnly, cashApp)).toHaveLength(0);
  });

  test("evidence needs a reference, a real amount and finance authority, and not the deal's own salesperson", async () => {
    const s = await seed("u4");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const base = { orgId: s.orgId, applicationId, amountMinor: jod(400), paidAt: Date.now() - 1_000 };

    const confirm = (caller: Seeded["approver"], overrides: Partial<typeof base> & { reference: string }) =>
      refusalOf(caller.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
        ...base, ...overrides, idempotencyKey: crypto.randomUUID(),
      }));

    expect((await confirm(s.approver, { reference: "   " }))?.message).toContain("reference is required");
    expect((await confirm(s.approver, { amountMinor: 0, reference: "TRF-1" }))?.message).toContain(
      "positive whole number of minor units"
    );
    expect((await confirm(s.approver, { paidAt: Date.now() + 86_400_000, reference: "TRF-1" }))?.message).toContain(
      "not in the future"
    );
    // No finance-disbursement authority.
    expect((await confirm(s.actors.Clerk, { reference: "TRF-1" }))?.message).toContain(
      "Missing required permissions: confirm:finance_disbursement"
    );
    // The salesperson who sold the deal does not confirm money that raises their own deal's profit.
    expect((await confirm(s.owner, { reference: "TRF-1" }))?.message).toContain("on your own deal");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));
    expect(await rowsOf(s, applicationId)).toHaveLength(0);
  });

  test("a replayed confirmation records one row, not two", async () => {
    const s = await seed("u5");
    const applicationId = await resolvedDeal(s, { customer: 600, dealer: 250, cash: 0, financeCompany: 600 });
    const args = {
      orgId: s.orgId, applicationId, amountMinor: jod(200), paidAt: Date.now() - 1_000, reference: "TRF-1",
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, args);
    const replay = await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, args);
    expect(replay).toEqual(first);
    const rows = await s.t.run((ctx) => ctx.db.query("customerFinanceCompanyPayments").collect());
    expect(rows).toHaveLength(1);
    expect((await appOf(s, applicationId))?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(200));
  });

  test("voiding the evidence before closing restores the contribution and blocks closing again", async () => {
    const s = await seed("u6");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const paymentId = await confirmPayment(s, applicationId, 400);
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));

    // A reason is required.
    expect(await refusalOf(s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId, reason: "  ",
    }))).not.toBeNull();
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId, reason: "The transfer bounced.",
    });
    const voided = await appOf(s, applicationId);
    expect(voided?.dealerContributionMinor).toBe(jod(1_225));
    expect(voided?.customerGapToFinanceCompanyAppliedMinor ?? 0).toBe(0);
    expect((await refusalOf(finalizeAsOwner(s, applicationId)))?.code).toBe(
      "CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED"
    );
    // The row is kept, marked void, with who and why.
    const row = await s.t.run((ctx) => ctx.db.get(paymentId));
    expect(row).toMatchObject({ status: "VOIDED", voidReason: "The transfer bounced." });
    // It can be confirmed again.
    await confirmPayment(s, applicationId, 400, "TRF-RETRY");
    await finalizeAsOwner(s, applicationId);
    expect((await appOf(s, applicationId))?.financeCompanyForwardDueMinor).toBe(jod(825));
  });

  test("once the deal is closed the evidence is part of the frozen plan: it can be neither voided nor added to", async () => {
    const s = await seed("u7");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const paymentId = await confirmPayment(s, applicationId, 400);
    await finalizeAsOwner(s, applicationId);

    expect(await refusalOf(s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId, reason: "Too late.",
    }))).not.toBeNull();
    expect(await refusalOf(confirmPayment(s, applicationId, 1, "TRF-LATE"))).not.toBeNull();
    const app = await appOf(s, applicationId);
    expect(app?.dealerContributionMinor).toBe(jod(825));
    expect(app?.financeCompanyForwardDueMinor).toBe(jod(825));
    const row = await s.t.run((ctx) => ctx.db.get(paymentId));
    expect(row?.status).toBe("CONFIRMED");
  });

  test("withdrawing the approval clears the credit; the confirmed evidence stays on file", async () => {
    // Reopening is only possible before the handover seals the figures, so this deal stops short of it.
    const fresh = await seed("u8");
    const freshId = await approvedDeal(fresh);
    await agree(fresh, freshId, SPLIT_400_TO_COMPANY);
    await confirmPayment(fresh, freshId, 400);
    expect((await appOf(fresh, freshId))?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(400));

    await fresh.approver.as.mutation(api.financingEconomics.reopenApproval, {
      orgId: fresh.orgId, applicationId: freshId, reason: "The company revised the approval.",
    });
    const reopened = await appOf(fresh, freshId);
    expect(reopened?.dealerContributionMinor).toBeUndefined();
    expect(reopened?.customerGapToFinanceCompanyAppliedMinor).toBeUndefined();
    expect((await rowsOf(fresh, freshId)).map((row) => row.status)).toEqual(["CONFIRMED"]);
  });
});

describe("SCRUM-766 PR-B review: ONE balance of what is still unconfirmed", () => {
  test("a handed-over deal whose creditable part fell below the agreement closes on the creditable part, and nothing past it is accepted", async () => {
    const s = await seed("b1");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    // A first payment corrected upwards after handover (SCRUM-373 D2) shrinks the contribution the
    // customer's payment can replace from 1,225 to 325: creditable = min(400 agreed, 400 share, 325).
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: jod(1_400) }));
    await driveRecompute(s, applicationId, 1);
    const before = await appOf(s, applicationId);
    expect(before?.dealerContributionMinor).toBe(jod(325));
    expect(before?.customerGapToFinanceCompanyMinor).toBe(jod(400));
    // Control: nothing is confirmed yet, so the deal is rightly not closable.
    expect((await paymentCheckOf(s, applicationId)).status).toBe("BLOCKED");

    // The server accepts exactly the creditable part.
    await confirmPayment(s, applicationId, 325, "TRF-325");
    const after = await appOf(s, applicationId);
    expect(after?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(325));
    expect(after?.dealerContributionMinor).toBe(0);
    // Every reader agrees there is nothing left to confirm: the gate no longer waits on the uncreditable 75.
    expect((await paymentCheckOf(s, applicationId)).status).toBe("READY");
    // And the 75 cannot be "confirmed" to chase it: it would credit nothing.
    expect((await refusalOf(confirmPayment(s, applicationId, 75, "TRF-75")))?.message).toContain(
      "more than the customer agreed to pay the finance company"
    );
    expect(await rowsOf(s, applicationId)).toHaveLength(1);
    // The one stored balance: the creditable 325 before the confirmation, nothing after it.
    expect(before?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(jod(325));
    expect(after?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(0);
  });

  test("a partial confirmation leaves exactly the rest awaiting, in the stored balance the gate and the card both read", async () => {
    const s = await seed("b2");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    await confirmPayment(s, applicationId, 150, "TRF-1");
    const app = await appOf(s, applicationId);
    expect(app?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(jod(250));
    expect((await paymentCheckOf(s, applicationId)).status).toBe("BLOCKED");
    await confirmPayment(s, applicationId, 250, "TRF-2");
    expect((await appOf(s, applicationId))?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(0);
    expect((await paymentCheckOf(s, applicationId)).status).toBe("READY");
  });
});

describe("SCRUM-766 PR-B review: evidence belongs to the agreement it was confirmed against", () => {
  async function confirmedThenReapproved(tag: string) {
    const s = await seed(tag);
    const applicationId = await approvedDeal(s);
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);
    await confirmPayment(s, applicationId, 400, "TRF-OLD");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    await s.approver.as.mutation(api.financingEconomics.reopenApproval, {
      orgId: s.orgId, applicationId, reason: "The company revised the approval.",
    });
    await approveAt11500(s, applicationId);
    return { s, applicationId };
  }

  test("a payment confirmed against a withdrawn agreement does not credit the new one", async () => {
    const { s, applicationId } = await confirmedThenReapproved("l1");
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);

    // The new promise is a promise: no credit, no profit, until it is confirmed on its own.
    const app = await appOf(s, applicationId);
    expect(app?.customerGapToFinanceCompanyMinor).toBe(jod(400));
    expect(app?.dealerContributionMinor).toBe(jod(1_225));
    expect(app?.customerGapToFinanceCompanyAppliedMinor ?? 0).toBe(0);
    expect(app?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(jod(400));
    const check = await paymentCheckOf(s, applicationId);
    expect(check.status).toBe("BLOCKED");

    // The old evidence is not discarded: it is on file, still confirmed, and marked as an earlier agreement's.
    const listed = await listPayments(s, applicationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "CONFIRMED", amountMinor: jod(400), reference: "TRF-OLD", agreement: "PRIOR" });
  });

  test("the same real transfer cannot be re-recorded against the new agreement until the old record is corrected", async () => {
    const { s, applicationId } = await confirmedThenReapproved("l2");
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);
    // One transfer, one record: the earlier confirmation of TRF-OLD still stands.
    expect((await refusalOf(confirmPayment(s, applicationId, 400, "TRF-OLD")))?.message).toContain("already recorded");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));

    // The explicit disposition: take the old record back with a reason, then confirm it against the new agreement.
    const [prior] = await listPayments(s, applicationId);
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId: prior._id, reason: "Re-recorded against the revised agreement.",
    });
    await confirmPayment(s, applicationId, 400, "TRF-OLD");
    const app = await appOf(s, applicationId);
    expect(app?.dealerContributionMinor).toBe(jod(825));
    expect(app?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(0);
    expect((await paymentCheckOf(s, applicationId)).status).toBe("READY");
    const history = await listPayments(s, applicationId);
    expect(history.map((row) => [row.status, row.agreement])).toEqual([["VOIDED", "PRIOR"], ["CONFIRMED", "CURRENT"]]);
  });

  test("a new confirmation under the current agreement does not clear the old confirmed row: it is taken back first", async () => {
    const { s, applicationId } = await confirmedThenReapproved("l4");
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);

    // A different transfer, confirmed against the current agreement, fully covers it ...
    await confirmPayment(s, applicationId, 400, "TRF-NEW");
    const app = await appOf(s, applicationId);
    expect(app?.customerGapToFinanceCompanyUnconfirmedMinor).toBe(0);
    expect(app?.dealerContributionMinor).toBe(jod(825));
    // ... yet the old confirmed row still blocks: only taking it back clears it, and the reason says so in that order.
    const blocked = await paymentCheckOf(s, applicationId);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reasonCode).toBe("CUSTOMER_FINANCE_COMPANY_PAYMENT_SUPERSEDED");
    expect(blocked.reason).toContain("Take that confirmation back with a reason first");
    expect(blocked.reason).not.toContain(", or record");

    const prior = (await listPayments(s, applicationId)).find((row) => row.agreement === "PRIOR");
    expect(prior).toBeDefined();
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId: prior!._id, reason: "That transfer was recorded twice.",
    });
    expect((await paymentCheckOf(s, applicationId)).status).toBe("READY");
  });

  test("a new agreement that pays the finance company nothing still cannot close over an earlier agreement's confirmed payment", async () => {
    const { s, applicationId } = await confirmedThenReapproved("l3");
    await agree(s, applicationId, { customer: 400, dealer: 450, cash: 400, financeCompany: 0 });

    const app = await appOf(s, applicationId);
    expect(app?.customerGapToFinanceCompanyMinor ?? 0).toBe(0);
    expect(app?.dealerContributionMinor).toBe(jod(1_225));
    // Real money is on file that no agreement accounts for: the deal does not close until a person disposes of it.
    const blocked = await paymentCheckOf(s, applicationId);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reasonCode).toBe("CUSTOMER_FINANCE_COMPANY_PAYMENT_SUPERSEDED");
    expect(await listPayments(s, applicationId)).toHaveLength(1);

    const [prior] = await listPayments(s, applicationId);
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId: prior._id, reason: "Refunded to the customer by the finance company.",
    });
    expect((await paymentCheckOf(s, applicationId)).status).toBe("NOT_APPLICABLE");
    expect(await listPayments(s, applicationId)).toHaveLength(1);
  });
});

describe("SCRUM-766 PR-B review: one transfer is one confirmation", () => {
  test("the same transfer reference under a second idempotency key is refused; distinct transfers and a voided correction are not", async () => {
    const s = await seed("r1");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);

    // Control: two DIFFERENT transfers that together make the agreement are both accepted.
    await confirmPayment(s, applicationId, 200, "TRF-A");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_025));

    // The bank's 200 transfer confirmed a second time under another key (and a re-typed reference) is not new money.
    const duplicate = await refusalOf(confirmPayment(s, applicationId, 200, "  trf-a "));
    expect(duplicate?.message).toContain("already recorded");
    expect(await rowsOf(s, applicationId)).toHaveLength(1);
    const duplicated = await appOf(s, applicationId);
    expect(duplicated?.dealerContributionMinor).toBe(jod(1_025));
    expect(duplicated?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(200));
    expect((await paymentCheckOf(s, applicationId)).status).toBe("BLOCKED");

    await confirmPayment(s, applicationId, 200, "TRF-B");
    expect((await paymentCheckOf(s, applicationId)).status).toBe("READY");

    // A voided confirmation frees its reference: the correction is the SAME transfer recorded properly.
    const [first] = await rowsOf(s, applicationId);
    await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId: first._id, reason: "Typed the wrong amount.",
    });
    await confirmPayment(s, applicationId, 200, "TRF-A");
    expect((await appOf(s, applicationId))?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(400));
  });

  test("listPayments answers only for a deal of the caller's own organization", async () => {
    const mine = await seed("t1");
    const applicationId = await resolvedDeal(mine, SPLIT_400_TO_COMPANY);
    await confirmPayment(mine, applicationId, 100, "TRF-MINE");
    const other = await seed("t2");

    expect(await listPayments(mine, applicationId)).toHaveLength(1);
    // Another organization's finance user naming this deal learns nothing about it.
    const probe = await refusalOf(
      other.approver.as.query(api.customerFinanceCompanyPayments.listPayments, { orgId: other.orgId, applicationId })
    );
    expect(probe?.message).toContain("not found in this organization");
    // And cannot reach it by naming their own org with the foreign deal's id and then the foreign org.
    const crossOrg = await refusalOf(
      other.approver.as.query(api.customerFinanceCompanyPayments.listPayments, { orgId: mine.orgId, applicationId })
    );
    expect(crossOrg).not.toBeNull();
  });
});

/**
 * SCRUM-766 ruling Q2 x SCRUM-411 P2-01: the showroom's payment to the finance company before finalizing is
 * the contribution AS IT STANDS (hand-computed: 1,225 - 400 confirmed = 825, stamped with the plan
 * fingerprint it was made for). Once that cash has left, confirming or taking back the customer's payment
 * would change the contribution and leave the 825 on the books describing a plan that no longer exists. So
 * both commands refuse while ANY version of the payment is on the books, unsettled, or unreadable, and only a
 * POSTED reversal (taken back / reported returned) lets the correction proceed.
 */
describe("SCRUM-766 Q2 x SCRUM-411 P2-01: the customer's payment cannot change while the showroom's payment is live", () => {
  type AppId = Id<"financeApplications">;
  const payForward = async (s: Seeded, applicationId: AppId, expected: number) =>
    s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: await seedBank(s.t, s.orgId), paidAt: Date.now(),
      expectedAmountMinor: jod(expected), idempotencyKey: crypto.randomUUID(),
    });
  const takeBackForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
    });
  const reportReturned = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
  const voidEvidence = (s: Seeded, applicationId: AppId, paymentId: Id<"customerFinanceCompanyPayments">) =>
    s.approver.as.mutation(api.customerFinanceCompanyPayments.voidPayment, {
      orgId: s.orgId, applicationId, paymentId, reason: "The transfer bounced.",
    });
  const forwardProof = (s: Seeded, applicationId: AppId) =>
    s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!, FORWARD_VERSIONS_ONLY));
  const forwardStates = async (s: Seeded, applicationId: AppId) =>
    (await forwardProof(s, applicationId)).versions.map((version) => version.state);
  const RECOVERIES = [
    ["taken back before it was disbursed", takeBackForward, "REVERSED"],
    ["reported returned by the finance company", reportReturned, "RETURNED"],
  ] as const;
  /** Ten more versions than the proof reads, so it cannot be read. */
  const overflowForwardVersions = (s: Seeded, forwardId: Id<"financeCompanyForwards">) =>
    s.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(forwardId))!;
      for (let version = 2; version <= 11; version += 1) await ctx.db.insert("financeCompanyForwards", { ...row, version });
    });
  /**
   * Another organization in the SAME database (a second harness would hand out unrelated ids), whose
   * member holds every permission there: only the org check can refuse it.
   */
  async function outsiderOrg(s: Seeded, tag: string) {
    const orgId = await s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: `S766B ${tag}`, createdAt: Date.now() });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}.owner@example.com`, name: "owner" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [...ALL_PERMS], isSystemOwnerRole: true });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return orgId;
    });
    return { orgId, as: s.t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` }) };
  }

  /** Both commands refuse with the coded reason, and neither leaves a trace. */
  async function expectBothRefused(s: Seeded, applicationId: AppId, paymentId: Id<"customerFinanceCompanyPayments">) {
    const before = await stateOf(s);
    expect((await refusalOf(voidEvidence(s, applicationId, paymentId)))?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
    expect((await refusalOf(confirmPayment(s, applicationId, 1, "TRF-2")))?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
    expect(await stateOf(s)).toEqual(before);
  }

  /** Every row of every table: a refused command must leave all of it exactly as it found it (SCRUM-705). */
  const stateOf = (s: Seeded) => dbSnapshot(s.t, Object.keys(schema.tables));

  /** 400 agreed and confirmed (contribution 825), then the showroom's 825 is paid and ON THE BOOKS. */
  async function paidDeal(tag: string) {
    const s = await seed(tag);
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const paymentId = await confirmPayment(s, applicationId, 400);
    const forwardId = await payForward(s, applicationId, 825);
    // Control: the setup really is the hazardous state, not merely a recorded row.
    expect(await forwardStates(s, applicationId)).toEqual(["ON_BOOKS"]);
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    return { s, applicationId, paymentId, forwardId };
  }

  test("taking back the customer's payment after the showroom paid is refused with a coded reason, and nothing changes", async () => {
    const { s, applicationId, paymentId } = await paidDeal("g1");
    const before = await stateOf(s);

    const refusal = await refusalOf(voidEvidence(s, applicationId, paymentId));
    expect(refusal?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
    // The finance tier's figures are not echoed.
    expect(refusal?.message).not.toMatch(/\d/);
    expect(await stateOf(s)).toEqual(before);
    expect((await s.t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("CONFIRMED");
  });

  test("a confirmation left over from a withdrawn agreement blocks the showroom's payment until it is taken back, and taking it back is not a contribution change", async () => {
    // Confirmed against the first agreement, then the approval is reopened and the gap re-resolved before handover.
    const s = await seed("g1p");
    const applicationId = await approvedDeal(s);
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);
    const oldId = await confirmPayment(s, applicationId, 400, "TRF-OLD");
    await s.approver.as.mutation(api.financingEconomics.reopenApproval, {
      orgId: s.orgId, applicationId, reason: "The company revised the approval.",
    });
    await approveAt11500(s, applicationId);
    await agree(s, applicationId, SPLIT_400_TO_COMPANY);
    await handOver(s, applicationId);

    // The old confirmation credits nothing now, and it keeps the showroom from paying: no live forward can stand over it.
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));
    expect((await refusalOf(payForward(s, applicationId, 1_225)))?.code).toBe("CUSTOMER_FINANCE_COMPANY_PAYMENT_SUPERSEDED");
    expect(await forwardStates(s, applicationId)).toEqual([]);

    // Taking it back moves nothing, and is allowed; the same real transfer is then confirmed against the current agreement.
    await voidEvidence(s, applicationId, oldId);
    expect((await s.t.run((ctx) => ctx.db.get(oldId)))?.status).toBe("VOIDED");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));
    await confirmPayment(s, applicationId, 400, "TRF-NEW");
    await payForward(s, applicationId, 825);
    expect(await forwardStates(s, applicationId)).toEqual(["ON_BOOKS"]);
  });

  test("taking back a confirmation of a withdrawn agreement is allowed while the showroom's payment is live, because it credits nothing", async () => {
    // No command leaves a prior-agreement row beside a live forward (the row blocks the forward, above), so this
    // state is seeded: the confirmed row is copied in as an earlier agreement's. The command under test is real.
    const { s, applicationId, paymentId } = await paidDeal("g1q");
    const priorId = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(paymentId))!;
      return ctx.db.insert("customerFinanceCompanyPayments", { ...row, reference: "TRF-PRIOR", agreementResolvedAt: 1 });
    });
    expect((await listPayments(s, applicationId)).map((row) => row.agreement)).toEqual(["CURRENT", "PRIOR"]);

    await voidEvidence(s, applicationId, priorId);

    expect((await s.t.run((ctx) => ctx.db.get(priorId)))?.status).toBe("VOIDED");
    // The credited payment, the contribution and the showroom's payment are exactly as they were.
    expect((await s.t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("CONFIRMED");
    const app = await appOf(s, applicationId);
    expect(app?.dealerContributionMinor).toBe(jod(825));
    expect(app?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(400));
    expect(await forwardStates(s, applicationId)).toEqual(["ON_BOOKS"]);
    // The credited row itself is still protected.
    expect((await refusalOf(voidEvidence(s, applicationId, paymentId)))?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
  });

  test("confirming more of the customer's payment after the showroom paid is refused, where the same confirmation is accepted before it", async () => {
    // A re-agreement after handover is sealed, so the state is seeded: the agreement grew to 500 (customer 500,
    // showroom 350) and 100 of it is still unconfirmed. Only whether the showroom has paid differs between the deals.
    const widen = (s: Seeded, applicationId: AppId) =>
      s.t.run((ctx) => ctx.db.patch(applicationId, {
        customerGapToFinanceCompanyMinor: jod(500),
        customerGapShareMinor: jod(500),
        dealerGapShareMinor: jod(350),
        customerGapToFinanceCompanyUnconfirmedMinor: jod(100),
      }));

    const control = await seed("g2c");
    const controlId = await resolvedDeal(control, SPLIT_400_TO_COMPANY);
    await confirmPayment(control, controlId, 400, "TRF-1");
    await widen(control, controlId);
    await confirmPayment(control, controlId, 100, "TRF-2");
    expect(await rowsOf(control, controlId)).toHaveLength(2);

    const { s, applicationId } = await paidDeal("g2");
    await widen(s, applicationId);
    const before = await stateOf(s);
    const refusal = await refusalOf(confirmPayment(s, applicationId, 100, "TRF-2"));
    expect(refusal?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
    expect(refusal?.message).not.toMatch(/\d/);
    expect(await stateOf(s)).toEqual(before);
    expect(await rowsOf(s, applicationId)).toHaveLength(1);
  });

  test("a replayed confirmation still returns its first result after the showroom has paid", async () => {
    const s = await seed("g3");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const args = {
      orgId: s.orgId, applicationId, amountMinor: jod(400), paidAt: Date.now() - 1_000, reference: "TRF-1",
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, args);
    await payForward(s, applicationId, 825);

    // Same key, same command: the stored result, not a fresh judgment against the live payment.
    expect(await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, args)).toEqual(first);
    expect(await rowsOf(s, applicationId)).toHaveLength(1);
    // A NEW command with a new key is judged, and refused.
    const fresh = await refusalOf(
      s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, { ...args, reference: "TRF-2", idempotencyKey: crypto.randomUUID() })
    );
    expect(fresh?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");
  });

  test.each(RECOVERIES)("once the showroom's payment is %s (reversal POSTED), the correction proceeds and the payment can be made again", async (_label, recover, settled) => {
    const { s, applicationId, paymentId, forwardId } = await paidDeal(`g4${settled}`);
    expect((await refusalOf(voidEvidence(s, applicationId, paymentId)))?.code).toBe("CUSTOMER_PAYMENT_FORWARD_LIVE");

    await recover(s, applicationId, forwardId);
    expect(await forwardStates(s, applicationId)).toEqual([settled]);

    // The contribution rises back to 1,225 and the evidence is voided with its reason.
    await voidEvidence(s, applicationId, paymentId);
    expect((await s.t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("VOIDED");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));

    // The same transfer is confirmed again, and the showroom pays the reduced 825 as a second version.
    await confirmPayment(s, applicationId, 400, "TRF-AGAIN");
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    await payForward(s, applicationId, 825);
    expect((await forwardProof(s, applicationId)).versions.map((version) => [version.version, version.state])).toEqual([
      [1, settled],
      [2, "ON_BOOKS"],
    ]);
  });

  test("a payment that is not yet settled on the books also blocks both commands", async () => {
    const { s, applicationId, paymentId } = await paidDeal("g5");
    await s.t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", forwardPostKey(applicationId, 1)))
        .unique();
      await ctx.db.patch(event!._id, { status: "PENDING" });
    });
    expect(await forwardStates(s, applicationId)).toEqual(["POSTING_PENDING"]);
    await expectBothRefused(s, applicationId, paymentId);
  });

  test("a proof that cannot be read (more versions than the limit) fails closed", async () => {
    const { s, applicationId, paymentId, forwardId } = await paidDeal("g6");
    await overflowForwardVersions(s, forwardId);
    const proof = await forwardProof(s, applicationId);
    expect(proof.versions).toEqual([]);
    expect(proof.state).toBe("NEEDS_REPAIR");
    await expectBothRefused(s, applicationId, paymentId);
  });

  test("another organization naming this deal is refused as not found, whatever the showroom's payment says", async () => {
    const { s, applicationId, paymentId } = await paidDeal("g7");
    const { orgId: otherOrgId, as: outsider } = await outsiderOrg(s, "g7o");
    const before = await stateOf(s);

    const confirm = await refusalOf(
      outsider.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
        orgId: otherOrgId, applicationId, amountMinor: jod(1), paidAt: Date.now() - 1_000, reference: "TRF-X",
        idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(confirm?.message).toContain("not found in this organization");
    const take = await refusalOf(
      outsider.mutation(api.customerFinanceCompanyPayments.voidPayment, {
        orgId: otherOrgId, applicationId, paymentId, reason: "The transfer bounced.",
      })
    );
    expect(take?.message).toContain("not found in this organization");
    expect(await stateOf(s)).toEqual(before);
  });

  /**
   * The same hazard through every OTHER writer of the contribution. Handover seals most of them, and a
   * payment cannot be recorded before the handover, so these states are reached the only way a test can
   * reach a state no command produces: the INPUT is set directly (a repaired or legacy row, or a writer
   * added later) and the next real command is what must refuse. Each refusal is judged against a control on
   * a deal with no payment, where the identical setup and command DO move the contribution - so the refusal
   * is the payment's, not a side effect of the setup.
   */
  describe("any other change to the showroom's contribution", () => {
    /** A first payment 100 higher: a different composition, so a different contribution. */
    const raiseFirstPayment = (s: Seeded, applicationId: AppId) =>
      s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: jod(600) }));
    const reopen = (s: Seeded, applicationId: AppId) =>
      s.approver.as.mutation(api.financingEconomics.reopenApproval, {
        orgId: s.orgId, applicationId, reason: "The company changed its approval.",
      });
    const reappraise = (s: Seeded, applicationId: AppId) =>
      s.owner.as.mutation(api.financingEconomics.recordAppraisal, {
        orgId: s.orgId, applicationId, appraisalAmountMinor: jod(11_000), providerType: "FINANCE_COMPANY",
        appraisedAt: Date.now(),
      });
    const unhandOver = (s: Seeded, applicationId: AppId) =>
      s.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: undefined }));

    test("a recompute that would move the contribution is refused, rolls the whole command back, and the control moves it", async () => {
      const control = await seed("h2c");
      const controlId = await resolvedDeal(control, SPLIT_400_TO_COMPANY);
      await confirmPayment(control, controlId, 400);
      await raiseFirstPayment(control, controlId);
      await driveRecompute(control, controlId, 1);
      expect((await appOf(control, controlId))?.dealerContributionMinor).not.toBe(jod(825));

      const { s, applicationId } = await paidDeal("h2");
      await raiseFirstPayment(s, applicationId);
      const before = await stateOf(s);
      const refusal = await refusalOf(driveRecompute(s, applicationId, 1));
      expect(refusal?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
      expect(refusal?.message).not.toMatch(/\d/);
      // The fee the command was recording is gone with it, not merely the contribution untouched.
      expect(await stateOf(s)).toEqual(before);
      expect(await forwardStates(s, applicationId)).toEqual(["ON_BOOKS"]);
    });

    test("a recompute that clears the contribution is refused too, and the control clears it", async () => {
      const clearInput = (s: Seeded, id: AppId) => s.t.run((ctx) => ctx.db.patch(id, { customerFirstPaymentMinor: undefined }));
      const control = await seed("h3c");
      const controlId = await resolvedDeal(control, SPLIT_400_TO_COMPANY);
      await confirmPayment(control, controlId, 400);
      await clearInput(control, controlId);
      await driveRecompute(control, controlId, 1);
      expect((await appOf(control, controlId))?.dealerContributionMinor).toBeUndefined();

      const { s, applicationId } = await paidDeal("h3");
      await clearInput(s, applicationId);
      const before = await stateOf(s);
      expect((await refusalOf(driveRecompute(s, applicationId, 1)))?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
      expect(await stateOf(s)).toEqual(before);
      expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    });

    test("a recompute that leaves the contribution exactly as it is still runs while the payment is live", async () => {
      const { s, applicationId } = await paidDeal("h4");
      const revision = (await appOf(s, applicationId))?.economicsRevision ?? 0;
      await driveRecompute(s, applicationId, 1);
      const after = await appOf(s, applicationId);
      expect(after?.economicsRevision ?? 0).toBeGreaterThan(revision);
      expect(after?.dealerContributionMinor).toBe(jod(825));
      expect(await forwardStates(s, applicationId)).toEqual(["ON_BOOKS"]);
    });

    test.each(RECOVERIES)("once the showroom's payment is %s, the refused recompute proceeds", async (_label, recover, settled) => {
      const { s, applicationId, forwardId } = await paidDeal(`h5${settled}`);
      await raiseFirstPayment(s, applicationId);
      expect((await refusalOf(driveRecompute(s, applicationId, 1)))?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");

      await recover(s, applicationId, forwardId);
      expect(await forwardStates(s, applicationId)).toEqual([settled]);
      await driveRecompute(s, applicationId, 2);
      expect((await appOf(s, applicationId))?.dealerContributionMinor).not.toBe(jod(825));
    });

    test("a payment history too long to read refuses the recompute rather than guessing", async () => {
      const { s, applicationId, forwardId } = await paidDeal("h6");
      await overflowForwardVersions(s, forwardId);
      await raiseFirstPayment(s, applicationId);
      const before = await stateOf(s);
      expect((await refusalOf(driveRecompute(s, applicationId, 1)))?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
      expect(await stateOf(s)).toEqual(before);
    });

    test.each([
      ["reopening the approval", reopen],
      ["a new appraisal that withdraws the approval", reappraise],
    ] as const)("%s clears the contribution, so it is refused while the payment is live, and the control clears it", async (_label, clear) => {
      const control = await seed("h7c");
      const controlId = await resolvedDeal(control, SPLIT_400_TO_COMPANY);
      await unhandOver(control, controlId);
      await clear(control, controlId);
      expect((await appOf(control, controlId))?.dealerContributionMinor).toBeUndefined();

      const { s, applicationId } = await paidDeal("h7");
      await unhandOver(s, applicationId);
      const before = await stateOf(s);
      const refusal = await refusalOf(clear(s, applicationId));
      expect(refusal?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
      expect(refusal?.message).not.toMatch(/\d/);
      expect(await stateOf(s)).toEqual(before);
    });

    test("once the payment is taken back, the approval can be reopened and the contribution is cleared", async () => {
      const { s, applicationId, forwardId } = await paidDeal("h8");
      await unhandOver(s, applicationId);
      expect((await refusalOf(reopen(s, applicationId)))?.code).toBe("DEAL_ECONOMICS_FORWARD_LIVE");
      await takeBackForward(s, applicationId, forwardId);
      await reopen(s, applicationId);
      expect((await appOf(s, applicationId))?.dealerContributionMinor).toBeUndefined();
    });

    test("another organization naming this deal is refused as not found before the payment is consulted", async () => {
      const { s, applicationId } = await paidDeal("h9");
      await unhandOver(s, applicationId);
      const other = await outsiderOrg(s, "h9o");
      const before = await stateOf(s);
      const refusal = await refusalOf(
        other.as.mutation(api.financingEconomics.reopenApproval, {
          orgId: other.orgId, applicationId, reason: "Not mine to reopen.",
        })
      );
      expect(refusal?.message).toContain("not found in this organization");
      expect(await stateOf(s)).toEqual(before);
    });
  });
});

describe("SCRUM-766 PR-B: a sourced (consigned) car follows the same evidence rule", () => {
  test("agreed but unconfirmed blocks closing; confirmed forwards 825 on the unreduced commission margin", async () => {
    const s = await seed("s1", { sourced: true });
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);

    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));
    await s.approver.as.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
    });
    expect((await refusalOf(finalizeAsOwner(s, applicationId)))?.code).toBe(
      "CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED"
    );

    await confirmPayment(s, applicationId, 400);
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(825));
    // The evidence check no longer blocks. A consigned sale whose quotation differs from the
    // approved amount is still refused by the posting rule (`consignedAgentSaleLines`, a
    // separate and older invariant), so closing is judged only on not being refused for THIS reason.
    const afterConfirm = await refusalOf(finalizeAsOwner(s, applicationId));
    expect(afterConfirm?.code).not.toBe("CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED");
  });
});
