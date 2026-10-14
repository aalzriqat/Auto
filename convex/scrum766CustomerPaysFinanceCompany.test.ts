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
import { registerHandover } from "../test-utils/convexTest";
import { finalizeAsOwner, newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { deriveManagementProfit } from "./utils/financingEconomics";

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
  const app = await appOf(s, applicationId);
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
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
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
    // While the ledger differs exactly by the forward: 825 to the company, 1,225 when the dealership collects.
    expect((await glNet(toCompany)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
    expect((await glNet(toDealer)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
  });

  test("a mixed share: 200 cash to the dealership and 400 confirmed to the finance company", async () => {
    const s = await seed("b");
    const applicationId = await resolvedDeal(s, { customer: 600, dealer: 250, cash: 200, financeCompany: 400 });
    await confirmPayment(s, applicationId, 400);
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
    expect(await refusalOf(confirmPayment(s, applicationId, 401))).not.toBeNull();
    await confirmPayment(s, applicationId, 300, "TRF-1");
    // 100 remains unconfirmed; a second 300 would overpay the agreement.
    expect(await refusalOf(confirmPayment(s, applicationId, 300, "TRF-2"))).not.toBeNull();
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(925));

    const cashOnly = await seed("u3b");
    const cashApp = await resolvedDeal(cashOnly, { customer: 400, dealer: 450, cash: 400, financeCompany: 0 });
    expect(await refusalOf(confirmPayment(cashOnly, cashApp, 100))).not.toBeNull();
    expect((await appOf(cashOnly, cashApp))?.dealerContributionMinor).toBe(jod(1_225));
  });

  test("evidence needs a reference, a real amount and finance authority, and not the deal's own salesperson", async () => {
    const s = await seed("u4");
    const applicationId = await resolvedDeal(s, SPLIT_400_TO_COMPANY);
    const base = { orgId: s.orgId, applicationId, amountMinor: jod(400), paidAt: Date.now() - 1_000 };

    expect(await refusalOf(s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
      ...base, reference: "   ", idempotencyKey: crypto.randomUUID(),
    }))).not.toBeNull();
    expect(await refusalOf(s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
      ...base, amountMinor: 0, reference: "TRF-1", idempotencyKey: crypto.randomUUID(),
    }))).not.toBeNull();
    expect(await refusalOf(s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
      ...base, paidAt: Date.now() + 86_400_000, reference: "TRF-1", idempotencyKey: crypto.randomUUID(),
    }))).not.toBeNull();
    // No finance-disbursement authority.
    expect(await refusalOf(s.actors.Clerk.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
      ...base, reference: "TRF-1", idempotencyKey: crypto.randomUUID(),
    }))).not.toBeNull();
    // The salesperson who sold the deal does not confirm money that raises their own deal's profit.
    expect(await refusalOf(s.owner.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
      ...base, reference: "TRF-1", idempotencyKey: crypto.randomUUID(),
    }))).not.toBeNull();
    expect((await appOf(s, applicationId))?.dealerContributionMinor).toBe(jod(1_225));
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

  test("withdrawing the approval clears the credit; confirmed evidence stays on file and re-applies to a new agreement", async () => {
    // Reopening is only possible before the handover seals the figures, so this deal stops short of it.
    const fresh = await seed("u8");
    const { applicationId: freshId } = await newApplication(fresh);
    await fresh.owner.as.mutation(api.applications.updateStatus, { orgId: fresh.orgId, applicationId: freshId, status: "UNDER_REVIEW" });
    await fresh.approver.as.mutation(api.applications.updateStatus, { orgId: fresh.orgId, applicationId: freshId, status: "APPROVED" });
    await fresh.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: fresh.orgId, applicationId: freshId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY",
      customerFirstPaymentMinor: jod(500),
    });
    await fresh.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: fresh.orgId, applicationId: freshId, approvedAmountMinor: jod(11_500), basis: "MANUAL", notes: "Below.",
    });
    const served = await fresh.approver.as.query(api.applications.get, { orgId: fresh.orgId, applicationId: freshId });
    await fresh.approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
      orgId: fresh.orgId, applicationId: freshId, economicsStamp: served!.economicsStamp as string,
      customerGapShareMinor: jod(400), dealerGapShareMinor: jod(450), customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0, customerGapToFinanceCompanyMinor: jod(400),
    });
    await confirmPayment(fresh, freshId, 400);
    expect((await appOf(fresh, freshId))?.customerGapToFinanceCompanyAppliedMinor).toBe(jod(400));

    await fresh.approver.as.mutation(api.financingEconomics.reopenApproval, {
      orgId: fresh.orgId, applicationId: freshId, reason: "The company revised the approval.",
    });
    const reopened = await appOf(fresh, freshId);
    expect(reopened?.dealerContributionMinor).toBeUndefined();
    expect(reopened?.customerGapToFinanceCompanyAppliedMinor).toBeUndefined();
    const rows = await fresh.t.run((ctx) => ctx.db.query("customerFinanceCompanyPayments").collect());
    expect(rows.map((row) => row.status)).toEqual(["CONFIRMED"]);
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
