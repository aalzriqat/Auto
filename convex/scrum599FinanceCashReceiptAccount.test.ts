/**
 * SCRUM-599 - the finance company's payment lands where the money landed.
 *
 * Invariant: the GL account debited when a finance-company disbursement is
 * confirmed is the account the money physically reached, and agrees with the
 * method on the canonical payment written in the same transaction:
 *   CASH -> CASH_ON_HAND (1100);
 *   BANK_TRANSFER, and CHEQUE (cleared in that same transaction) -> BANK_ACCOUNT (1110).
 * An event queued before the method was recorded keeps its historical posting
 * (BANK_ACCOUNT).
 *
 * Found by the SCRUM-595 browser matrix (scenario F07): a CASH receipt posted
 * Dr 1110 while its canonical payment said CASH.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import { convexTestWithComponents, registerHandover, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { financeReceiptAccountKey, ruleFinanceCashReceived } from "./accounting/postingRules";

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
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const G = 12_500_000; // minor units, JOD (3 decimals)
const SCALE = 1_000;

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S599 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = async (suffix: string) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@example.com`, name: suffix })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: suffix.toUpperCase(), permissions: ALL_PERMS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: `${tag}_${suffix}`, clerkId: `${tag}_${suffix}` });
  };
  const owner = await mkUser("owner");
  const approver = await mkUser("appr");
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER", "CHEQUE"] })
  );
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await owner.query(api.accountingPeriods.list, { orgId }))[0];
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100, adminFees: 0,
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN599${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: G / SCALE, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 9_000,
    })
  );
  return { t, orgId, customerId, customerStatusId, companyId, vehicleId, owner, approver };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;
type Method = "CASH" | "BANK_TRANSFER" | "CHEQUE";
/** MANUAL = the "Other finance option" route; CONFIGURED = a registered finance company (the only route a cheque may be registered on). */
type Route = "MANUAL" | "CONFIGURED";

/**
 * A finance deal on `route`, finalized with `method` registered as how the
 * company will pay, and nothing for the dealership to forward (S = 0, no deposit).
 */
async function finalizedDeal(tag: string, method: Method, route: Route) {
  const s = await seedDealership(tag);
  const quoteId = await s.owner.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: G / SCALE, downPayment: 0, termMonths: 48,
    ...(route === "MANUAL"
      ? { mode: "MANUAL_FINANCE_COMPANY" as const, manualProviderName: "Other finance option", manualAdminFees: 0, manualProfitRate: 5 }
      : {
          mode: "CONFIGURED_FINANCE_COMPANY" as const, companyId: s.companyId,
          customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: G / SCALE,
        }),
  });
  const applicationId = await s.owner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.owner.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  if (route === "MANUAL") {
    await s.approver.mutation(api.financingEconomics.recordManualFinanceApproval, {
      orgId: s.orgId, applicationId, approvedAmountMinor: G, financierName: "Al-Ameen Islamic Finance", dealerSendsMinor: 0,
    });
  } else {
    await s.owner.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
    });
    await s.approver.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
    });
  }
  await registerHandover(s.owner, api, s.orgId, applicationId);
  await s.owner.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method, expectedDate: Date.now(),
    ...(method === "CHEQUE"
      ? { chequeDetails: { bank: "QA Bank", chequeNumber: `CHQ-${tag}` }, faceAmount: (G / SCALE).toFixed(3) }
      : {}),
  });
  await s.owner.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  await recordReconciledZeroCost(s.owner, api, s.orgId, applicationId);
  await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 }));
  await s.owner.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId });
  return { s, applicationId };
}

const confirm = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.owner.mutation(api.applications.confirmDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
  });

/** Net debit-minus-credit per system key over the journals of every live FINANCE_CASH_RECEIVED event. */
async function receiptNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === "FINANCE_CASH_RECEIVED" && e.status === "POSTED"
    );
    const net: Record<string, number> = {};
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
          net[key] = (net[key] ?? 0) + line.debitMinor - line.creditMinor;
        }
      }
    }
    return { events: events.length, net };
  });
}

const canonicalMethod = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("canonicalPayments").collect())
      .filter((p) => {
        const payerType = (p as { payerType?: string }).payerType;
        return p.orgId === s.orgId && (payerType === "MANUAL_FINANCE_COMPANY" || payerType === "FINANCE_COMPANY");
      })
      .map((p) => p.method)
  );

const EXPECTED_ACCOUNT: Record<Method, "CASH_ON_HAND" | "BANK_ACCOUNT"> = {
  CASH: "CASH_ON_HAND",
  BANK_TRANSFER: "BANK_ACCOUNT",
  CHEQUE: "BANK_ACCOUNT",
};

describe("SCRUM-599 - the finance company's payment is debited to the account it reached", () => {
  test.each([
    ["MANUAL", "CASH"],
    ["MANUAL", "BANK_TRANSFER"],
    ["CONFIGURED", "CASH"],
    ["CONFIGURED", "BANK_TRANSFER"],
    ["CONFIGURED", "CHEQUE"],
  ] as const)(
    "%s route, %s: the receipt debits the account the method names, agreeing with the canonical payment",
    async (route, method) => {
      const { s, applicationId } = await finalizedDeal(`m_${route}_${method}`, method, route);
      await confirm(s, applicationId);

      const { events, net } = await receiptNet(s);
      expect(events).toBe(1);
      const other = EXPECTED_ACCOUNT[method] === "CASH_ON_HAND" ? "BANK_ACCOUNT" : "CASH_ON_HAND";
      expect(net).toEqual({
        [EXPECTED_ACCOUNT[method]]: G,
        ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: -G,
      });
      expect(net[other]).toBeUndefined();
      expect(await canonicalMethod(s)).toEqual([method]);
    }
  );

  test("the event payload records the method it was posted under", async () => {
    const { s, applicationId } = await finalizedDeal("payload", "CASH", "MANUAL");
    await confirm(s, applicationId);
    const event = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_CASH_RECEIVED"
      )
    );
    expect((event?.payload as { paymentMethod?: string } | undefined)?.paymentMethod).toBe("CASH");
  });

  test("an org whose cash account is unmapped queues the CASH receipt (with its method) and confirmation still succeeds; it posts to 1100 once mapped", async () => {
    const { s, applicationId } = await finalizedDeal("unmapped", "CASH", "MANUAL");
    const cashAccounts = await s.t.run(async (ctx) =>
      (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "CASH_ON_HAND")).collect())
    );
    expect(cashAccounts.length).toBeGreaterThan(0);
    await s.t.run(async (ctx) => {
      for (const a of cashAccounts) await ctx.db.patch(a._id, { active: false });
    });

    await confirm(s, applicationId);

    expect((await receiptNet(s)).events).toBe(0);
    const pending = await s.t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId)).collect()).filter(
        (p) => p.eventType === "FINANCE_CASH_RECEIVED"
      )
    );
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as { paymentMethod?: string }).paymentMethod).toBe("CASH");
    expect(await canonicalMethod(s)).toEqual(["CASH"]);

    // Mapping restored: the queued receipt drains to the cash account, not the bank.
    await s.t.run(async (ctx) => {
      for (const a of cashAccounts) await ctx.db.patch(a._id, { active: true });
    });
    // Real Date (periods are built from the calendar year); only timers faked,
    // as in accountingOutboxSweep.test.ts. The drain schedules the post.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    const { events, net } = await receiptNet(s);
    expect(events).toBe(1);
    expect(net).toEqual({ CASH_ON_HAND: G, ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: -G });
  });

  test("an unsupported method is refused rather than defaulted to the bank", () => {
    expect(() => financeReceiptAccountKey("INTERNAL_INSTALLMENT")).toThrow(/unsupported payment method/);
    expect(() =>
      ruleFinanceCashReceived({
        applicationId: "x", payerNameSnapshot: "Co", amountMinor: G, currency: "JOD",
        paymentMethod: "CARD" as unknown as "CASH",
      })
    ).toThrow(/unsupported payment method/);
  });

  test("a legacy event with no recorded method keeps its historical bank posting", () => {
    const result = ruleFinanceCashReceived({
      applicationId: "legacy", payerNameSnapshot: "Legacy Co", amountMinor: G, currency: "JOD",
    });
    const debit = result.lines.find((l) => l.debitMinor > 0);
    expect(debit?.accountSystemKey).toBe("BANK_ACCOUNT");
    expect(debit?.debitMinor).toBe(G);
  });
});
