/**
 * SCRUM-411 / SCRUM-407 c21031 - the server derives the financed sale; no employee
 * invents a legal amount, number or date.
 *
 * Owner worked example (the same numbers `financeCompanyForward.test.ts` uses):
 *   approved A = 12,500  deposit H = 200  showroom contribution C = 1,375
 * Manual oracle, worked from the ruling and NOT read back from the code:
 *   - the finance company transfers the FULL A, so AR-Finance = 12,500;
 *   - the sale consideration is A (no customer gap here) = 12,500, so SALES_REVENUE
 *     is credited 12,500 and the contribution is contra-revenue 1,375,
 *     i.e. net sale revenue 12,500 - 1,375 = 11,125;
 *   - the deposit H and the contribution C are forwarded to the company, so
 *     AP-Finance carries H + C = 1,575 and the deposit never adds to revenue.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import {
  C, G, H, closePriorYearPeriod, finalizeAsOwner, readyDeal, refusalDataOf, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { planConsiderationMinor } from "./accounting/postingRules";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

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

async function seed(tag: string, sourced = false) {
  return seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411", vinPrefix: "VIN411",
    actors: {}, sourced,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Net debit-positive movement per system account across the POSTED events of a type. */
async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net = new Map<string, number>();
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const account = await ctx.db.get(line.accountId);
          const key = account?.systemKey ?? String(line.accountId);
          net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
        }
      }
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

const getApp = (s: Seeded, applicationId: Id<"financeApplications">) => s.t.run((ctx) => ctx.db.get(applicationId));

const record = (
  s: Seeded,
  applicationId: Id<"financeApplications">,
  over: Partial<{
    legalInvoiceAmountMinor: number;
    issuedTo: "CUSTOMER" | "FINANCE_COMPANY" | "OTHER";
    issuedBy: "DEALERSHIP" | "THIRD_PARTY";
    issuerName: string;
    legalInvoiceDate: number;
  }> = {}
) =>
  s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId,
    legalInvoiceAmountMinor: over.legalInvoiceAmountMinor ?? G,
    legalInvoiceNumber: "INV-REAL-0001",
    legalInvoiceDate: over.legalInvoiceDate ?? Date.now() - 3 * 24 * 60 * 60 * 1000,
    issuedTo: over.issuedTo ?? "FINANCE_COMPANY",
    ...(over.issuedBy !== undefined ? { issuedBy: over.issuedBy } : {}),
    ...(over.issuerName !== undefined ? { issuerName: over.issuerName } : {}),
  });

describe("SCRUM-411 - a deal with no legal invoice closes from server-derived economics", () => {
  test("closes with no invoice recorded; revenue is A, contribution is contra-revenue, net 11,125", async () => {
    const s = await seed("noinv1");
    const { applicationId } = await readyDeal(s);
    // Guard: the fixture really recorded no invoice.
    expect((await getApp(s, applicationId))?.legalInvoiceAmountMinor).toBeUndefined();

    await finalizeAsOwner(s, applicationId);

    const app = await getApp(s, applicationId);
    expect(app?.status).toBe("CLOSED");
    expect(app?.financedSalePlanVersion).toBe(3);
    expect(app?.financedSaleRecognitionFingerprint?.startsWith("v3;")).toBe(true);
    expect(app?.financeCompanyForwardDueMinor).toBe(H + C);

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(G);
    expect(net.SALES_REVENUE).toBe(-G);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    // Manual oracle: 12,500,000 - 1,375,000 minor units.
    expect(-(net.SALES_REVENUE ?? 0) - (net.SALES_CONSIDERATION_REDUCTIONS ?? 0)).toBe(11_125_000);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-(H + C));
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("the sale is dated by the recorded handover, not by any document date", async () => {
    const s = await seed("date1");
    const { applicationId } = await readyDeal(s);
    const handoverAt = (await getApp(s, applicationId))?.vehicleHandoverAt;
    expect(handoverAt).toBeDefined();
    // A genuine invoice with an unrelated (older) printed date must not move the sale.
    const printed = Date.now() - 20 * 24 * 60 * 60 * 1000;
    await record(s, applicationId, { legalInvoiceDate: printed });

    await finalizeAsOwner(s, applicationId);

    const app = await getApp(s, applicationId);
    const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
    expect(sale?.saleDate).toBe(handoverAt);
    expect(sale?.saleDate).not.toBe(printed);
  });

  test("a recorded genuine invoice is evidence only: revenue stays the server's figure", async () => {
    const s = await seed("evid1");
    const { applicationId } = await readyDeal(s);
    await record(s, applicationId, { legalInvoiceAmountMinor: G });
    await finalizeAsOwner(s, applicationId);

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.SALES_REVENUE).toBe(-G);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect((await getApp(s, applicationId))?.legalInvoiceAmountMinor).toBe(G);
  });

  test("a handover dated in a CLOSED accounting period blocks the close before anything is written", async () => {
    const s = await seed("period1");
    const { applicationId } = await readyDeal(s);
    // A real prior-year period, opened and then closed through the accounting-period mutations.
    const { periodId, handoverAt } = await closePriorYearPeriod(s);
    expect((await s.t.run((ctx) => ctx.db.get(periodId)))?.status).toBe("CLOSED");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: handoverAt }));

    // No payment to the company first: the period refusal fires before the forward gate, and a
    // payment would itself write an accounting event the "nothing written" checks below forbid.
    const refusal = await refusalDataOf(finalizeAsOwner(s, applicationId, { payForward: false }));
    expect(refusal).toEqual({
      code: "RECOGNITION_PERIOD_NOT_OPEN",
      message:
        "The vehicle was handed over on a date that has no open accounting period, so the sale cannot be recognised. Open or reopen that period before finalizing.",
    });

    const app = await getApp(s, applicationId);
    expect(app?.status).not.toBe("CLOSED");
    expect(app?.finalizedSaleId).toBeUndefined();
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("journalEntries").collect())).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("journalLines").collect())).toHaveLength(0);
    expect(await netByAccount(s, "SALE_COMPLETED")).toEqual({});
  });
});

describe("SCRUM-411 - replacing a recorded invoice is audited, whichever field moved", () => {
  test("an issuer-only replacement writes an audit row whose before and after name the two issuers", async () => {
    const s = await seed("auditIssuer", true);
    const { applicationId } = await readyDeal(s);
    const original = { issuedBy: "THIRD_PARTY" as const, issuerName: "Importer A" };
    await record(s, applicationId, original);
    // Same amount, number, date and recipient: only the issuer's identity changes.
    const date = (await getApp(s, applicationId))?.legalInvoiceDate;
    await record(s, applicationId, { ...original, issuerName: "Importer B", legalInvoiceDate: date });

    const rows = await s.t.run((ctx) =>
      ctx.db.query("financeApplicationOverrides").collect()
    );
    const audit = rows.filter((r) => r.applicationId === applicationId && r.field === "legalInvoiceAmountMinor");
    expect(audit).toHaveLength(1);
    expect(audit[0].previousValue).toContain("issued by THIRD_PARTY — Importer A");
    expect(audit[0].newValue).toContain("issued by THIRD_PARTY — Importer B");
    expect(audit[0].previousValue).not.toBe(audit[0].newValue);
  });
});

describe("SCRUM-411 - an invoice that is recorded must be genuine for this deal", () => {
  test.each([
    ["issued to the customer", { issuedTo: "CUSTOMER" as const }, /financing company is the legal buyer/i],
    ["by a third party on dealer-owned stock", { issuedBy: "THIRD_PARTY" as const, issuerName: "Some Importer" }, /dealer-owned stock/i],
  ])("a dealer-owned deal refuses an invoice %s", async (_name, over, message) => {
    const s = await seed(`own_${_name.length}`);
    const { applicationId } = await readyDeal(s);
    const refusal = await refusalMessageOf(record(s, applicationId, over));
    expect(refusal).toMatch(message);
    expect((await getApp(s, applicationId))?.legalInvoiceAmountMinor).toBeUndefined();
  });

  // A single named check (not a test.each row) so the regression library can bind to it exactly.
  test("a dealer-owned deal refuses an invoice for the approved amount plus the customer's gap", async () => {
    const s = await seed("ownGap");
    const { applicationId } = await readyDeal(s);
    const refusal = await refusalMessageOf(record(s, applicationId, { legalInvoiceAmountMinor: G + 400_000 }));
    expect(refusal).toMatch(/does not match the amount the finance company approved/i);
    expect((await getApp(s, applicationId))?.legalInvoiceAmountMinor).toBeUndefined();
  });

  test("a consigned car's invoice is its importer's: the dealership's name is refused, a named third party accepted", async () => {
    const s = await seed("cons1", true);
    const { applicationId } = await readyDeal(s);

    expect(await refusalMessageOf(record(s, applicationId))).toMatch(/supplier or importer/i);
    expect(
      await refusalMessageOf(record(s, applicationId, { issuedBy: "THIRD_PARTY", issuerName: "  " }))
    ).toMatch(/supplier or importer/i);
    expect((await getApp(s, applicationId))?.legalInvoiceAmountMinor).toBeUndefined();

    expect(
      await refusalMessageOf(record(s, applicationId, { issuedBy: "THIRD_PARTY", issuerName: "Amman Importer Co" }))
    ).toBeNull();
    const app = await getApp(s, applicationId);
    expect(app?.legalInvoiceIssuedBy).toBe("THIRD_PARTY");
    expect(app?.legalInvoiceIssuerName).toBe("Amman Importer Co");
  });

  test("an invoice cannot be recorded before the approval it must match exists", async () => {
    const s = await seed("noappr1");
    const quote = await s.owner.as.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
      vehiclePrice: G / 1_000, downPayment: 0, termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
      customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: G / 1_000,
    });
    const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId: quote });
    expect(await refusalMessageOf(record(s, applicationId))).toMatch(/approved amount/i);
  });
});

describe("SCRUM-411 - each plan version reads only its own consideration field", () => {
  test("v3 reads considerationMinor; v2 keeps reading the invoice-sourced field", () => {
    expect(planConsiderationMinor({ version: 3, considerationMinor: 12_500_000 })).toBe(12_500_000);
    expect(planConsiderationMinor({ version: 2, legalInvoiceConsiderationMinor: 13_000_000 })).toBe(13_000_000);
  });

  test("a version never falls through to the other version's field", () => {
    // A v3 event carrying only an invoice amount must not post from it, and the reverse.
    expect(() => planConsiderationMinor({ version: 3, legalInvoiceConsiderationMinor: 13_000_000 })).toThrow();
    expect(() => planConsiderationMinor({ version: 2, considerationMinor: 12_500_000 })).toThrow();
    expect(() => planConsiderationMinor({ version: 3 })).toThrow();
    expect(() => planConsiderationMinor({ version: 3, considerationMinor: -1 })).toThrow();
  });
});
