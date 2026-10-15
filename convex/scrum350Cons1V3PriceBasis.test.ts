/**
 * SCRUM-350 CONS-1 v3 / SCRUM-411 / SCRUM-407 c21031 - a financed CONSIGNED (SOURCED) sale whose
 * approval is below its price books its revenue on what the dealership is actually paid
 * (approved + the customer's gap), never on the car's sale price.
 *
 * The same hand-worked deal the browser swarm's CONS-1 mission seeds (JOD, minor units, scale 1,000):
 *   price P 20,000 . supplier entitlement E 15,000 . quotation 20,000 . approved A 18,000
 *   company LTV 85% . deposit H 200 (also the customer's first payment)
 *   contribution D: quotation 20,000 -> 20,000 - 17,000 - 200 = 2,800; approval 18,000 -> 18,000 - 15,300 - 200 = 2,500
 *   net shortfall S = (20,000 - 2,800) - (18,000 - 2,500) = 1,700 (the gross gap would be 2,000)
 *   the customer agrees to pay R = 1,000 to the dealership in cash; the dealership absorbs 700
 *   forward due to the financier H + D = 2,700
 *   consideration K = A + R = 19,000
 * Expected SALE_COMPLETED journal (debits = credits = 21,700):
 *   Dr AR-finance 18,000 . Dr AR-customers 1,000 . Dr deposits 200 . Dr contra-revenue 2,500
 *   Cr AP-finance 2,700 . Cr AP-suppliers 15,000 . Cr consignment commission 4,000
 * Net revenue = 4,000 - 2,500 = 1,500. A margin measured on the PRICE would be 20,000 - 15,000 - 2,500
 * = 2,500, 1,000 too much: P - K. Approved < price alone would not tell the two apart (a gap of 2,000
 * fills the difference), which is why this deal's gap is smaller than the shortfall.
 *
 * Every figure below is written out by hand, never read back from the code under test. The supplier
 * subledger row (`vehicleSupplierPayables`) is judged beside the GL: the canonical record of what the
 * dealership owes the supplier must agree with the 15,000 the journal credits.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime and not
 * production data.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { recordReconciledZeroCost, registerHandover } from "../test-utils/convexTest";
import { finalizeAsOwner, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { deriveSettlementStatus } from "./utils/supplierSettlement";

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

/** The hand-worked expectation, debit-positive net per account, in minor units. */
const EXPECTED_SALE_JOURNAL = {
  ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: jod(18_000),
  ACCOUNTS_RECEIVABLE_CUSTOMERS: jod(1_000),
  CUSTOMER_DEPOSITS_LIABILITY: jod(200),
  SALES_CONSIDERATION_REDUCTIONS: jod(2_500),
  ACCOUNTS_PAYABLE_FINANCE_COMPANIES: -jod(2_700),
  ACCOUNTS_PAYABLE_SUPPLIERS: -jod(15_000),
  CONSIGNMENT_COMMISSION_REVENUE: -jod(4_000),
} as const;

/** Net revenue a SALE_COMPLETED journal recognizes: commission credited less contra-revenue debited. */
function netRevenueOf(net: Record<string, number>): number {
  return 0 - (net.CONSIGNMENT_COMMISSION_REVENUE ?? 0) - (net.SALES_CONSIDERATION_REDUCTIONS ?? 0);
}

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S350C1", vinPrefix: "VIN350C",
    actors: {}, sourced: true,
  });
  // The fixture's 12,500 car and 100% lender become the 20,000 consigned car and the 85% lender.
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.vehicleId, { sellingPrice: 20_000, sourceCost: 15_000 });
    await ctx.db.patch(s.companyId, { defaultLtvPercent: 85 });
  });
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Debit-positive net per system account across the live events of one type. */
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
          net[key] = (net[key] ?? 0) + line.debitMinor - line.creditMinor;
        }
      }
    }
    return net;
  });
}

/** Drives the 20,000 consigned car to a finalized, forwarded deal through the real public mutations. */
async function closeDeal(s: Seeded) {
  const { owner, approver, orgId } = s;
  const quoteId = await owner.as.mutation(api.quotes.saveQuote, {
    orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: 20_000,
  });
  await owner.as.mutation(api.deposits.create, { orgId, quoteId, amount: 200, method: "CASH", idempotencyKey: "dep-350c1" });
  const applicationId = await owner.as.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId, applicationId, route: "THROUGH_DEALERSHIP" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(20_000), source: "MANUAL_ENTRY", customerFirstPaymentMinor: jod(200),
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: jod(18_000), basis: "MANUAL", notes: "Approved below the quotation.",
  });

  // The product derives the net shortfall and the contribution itself; they must equal the hand figures.
  const derived = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(derived?.netShortfallMinor).toBe(jod(1_700));
  expect(derived?.dealerContributionMinor).toBe(jod(2_500));

  const served = await approver.as.query(api.applications.get, { orgId, applicationId });
  await approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
    orgId, applicationId, economicsStamp: served!.economicsStamp as string,
    customerGapShareMinor: jod(1_000), dealerGapShareMinor: jod(700),
    customerGapCashToDealerMinor: jod(1_000), customerGapInstallmentToDealerMinor: 0, customerGapToFinanceCompanyMinor: 0,
  });

  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  // No legal invoice: under v3 the server derives the consideration (A + R).
  await recordReconciledZeroCost(owner.as, api, orgId, applicationId);
  // H + D = 2,700, an amount the product must itself agree is due.
  await approver.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now() - 5_000,
    expectedAmountMinor: jod(2_700), idempotencyKey: crypto.randomUUID(),
  });
  await finalizeAsOwner(s, applicationId, { payForward: false });

  const app = await s.t.run((ctx) => ctx.db.get(applicationId));
  const saleId = app!.finalizedSaleId as Id<"sales">;
  return { saleId, app: app!, sale: (await s.t.run((ctx) => ctx.db.get(saleId)))! };
}

describe("SCRUM-350 CONS-1 v3: a financed consigned sale approved below its price", () => {
  test("P 20,000, A 18,000, R 1,000, D 2,500, H 200: the sale posts net revenue 1,500, not the price-basis 2,500", async () => {
    const s = await seed("v3a");
    const { app, sale } = await closeDeal(s);

    expect(app.status).toBe("CLOSED");
    // The sale price is the quote's 20,000: approved + gap (19,000) is not the price.
    expect(sale.salePrice).toBe(20_000);
    expect(app.legalInvoiceAmountMinor).toBeUndefined();

    const net = await netByAccount(s, "SALE_COMPLETED");
    // Account for account, independently derived. The exact match also proves the entry balances and
    // that the car's price, cost and inventory never reach SALES_REVENUE, COGS or VEHICLE_INVENTORY.
    expect(net).toEqual(EXPECTED_SALE_JOURNAL);

    // Hand figures: A + R - E - D = 18,000 + 1,000 - 15,000 - 2,500. The price basis,
    // P - E - D = 20,000 - 15,000 - 2,500 = 2,500, would be 1,000 (P - (A + R)) higher.
    expect(netRevenueOf(net)).toBe(jod(1_500));
  });

  test("the supplier subledger row agrees with the GL: one payable for this sale and car, 15,000, unpaid", async () => {
    const s = await seed("v3b");
    const { saleId } = await closeDeal(s);

    const net = await netByAccount(s, "SALE_COMPLETED");
    const rows = await s.t.run((ctx) => ctx.db.query("vehicleSupplierPayables").withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, amountDue: 15_000, currency: "JOD", sourcedFromName: "Amman Importer Co",
    });
    // Sale completion stores PENDING (no due trigger); the settlement status every reader derives from it is
    // DUE_ON_SALE, because the sale now exists and nothing is paid.
    expect(rows[0].status).toBe("PENDING");
    expect(deriveSettlementStatus(rows[0])).toBe("DUE_ON_SALE");
    expect(rows[0].amountPaid ?? 0).toBe(0);
    // The journal's supplier payable is the same 15,000 the subledger holds.
    expect(-net.ACCOUNTS_PAYABLE_SUPPLIERS).toBe(jod(rows[0].amountDue));

    // The public, permission-checked list the browser mission reads shows the same single row for this sale.
    const listed = await s.owner.as.query(api.sourcingPayables.list, { orgId: s.orgId });
    const forSale = listed.filter((row) => row.saleId === saleId);
    expect(forSale).toHaveLength(1);
    expect(forSale[0]).toMatchObject({ amountDue: 15_000, currency: "JOD", vehicleId: s.vehicleId });
  });
});
