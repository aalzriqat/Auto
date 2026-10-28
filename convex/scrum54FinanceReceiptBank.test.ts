/**
 * SCRUM-54 - a finance-company receipt names the physical bank it reached.
 *
 * Invariant: a BANK_TRANSFER or cleared CHEQUE receipt confirmed at
 * applications.confirmDisbursement carries an explicit, validated
 * `bankAccountId` (active, same org, same currency, not deleted) through the
 * FINANCE_CASH_RECEIVED payload to the BANK_ACCOUNT journal line, and through
 * its reversal. A CASH receipt stays cash on hand and names no bank. A refused
 * bank leaves nothing behind. Nothing defaults to the only bank.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import { convexTestWithComponents, registerHandover, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S54R ${tag}`, createdAt: Date.now() }));
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

  const ownerUser = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
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
      orgId, vin: `VIN54R${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: G / SCALE, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 9_000,
    })
  );
  return { t, orgId, ownerUser, customerId, customerStatusId, companyId, vehicleId, owner, approver };
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

const confirmWith = (
  s: Seeded,
  applicationId: Id<"financeApplications">,
  bankAccountId?: Id<"bankAccounts">,
  key: string = crypto.randomUUID()
) =>
  s.owner.mutation(api.applications.confirmDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: key,
    ...(bankAccountId ? { bankAccountId } : {}),
  });

async function insertBank(
  s: Seeded,
  over: Partial<{ orgId: Id<"organizations">; currency: string; isActive: boolean; isDeleted: boolean }> = {}
) {
  const now = Date.now();
  return await s.t.run((ctx) =>
    ctx.db.insert("bankAccounts", {
      orgId: over.orgId ?? s.orgId, name: "Operating bank", currency: over.currency ?? "JOD",
      openingBalanceMinor: 0, openingBalanceDate: now, isActive: over.isActive ?? true,
      isReconciliationTarget: false, createdBy: s.ownerUser, createdAt: now, updatedAt: now, isDeleted: over.isDeleted,
    })
  );
}

/** Every table a confirmation could write to, so a refusal can prove it wrote none. */
const effects = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.t.run(async (ctx) => ({
    app: await ctx.db.get(applicationId),
    events: (await ctx.db.query("accountingEvents").collect()).length,
    pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    payments: (await ctx.db.query("canonicalPayments").collect()).length,
    allocations: (await ctx.db.query("paymentAllocations").collect()).length,
    cheques: await ctx.db.query("postDatedCheques").collect(),
  }));

/** Journal lines of every FINANCE_CASH_RECEIVED entry and of the reversals of those entries. */
async function receiptLines(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === "FINANCE_CASH_RECEIVED"
    );
    const eventIds = new Set(events.map((e) => e._id));
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const forward = entries.filter((e) => e.accountingEventId !== undefined && eventIds.has(e.accountingEventId));
    const forwardIds = new Set(forward.map((e) => e._id));
    const reversals = entries.filter((e) => e.reversalOfJournalEntryId !== undefined && forwardIds.has(e.reversalOfJournalEntryId));
    const out: {
      key: string; bankAccountId?: Id<"bankAccounts">; debitMinor: number; creditMinor: number; reversal: boolean;
    }[] = [];
    for (const [group, isReversal] of [[forward, false], [reversals, true]] as const) {
      for (const entry of group) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          out.push({
            key: (await ctx.db.get(line.accountId))?.systemKey ?? "?",
            bankAccountId: line.bankAccountId, debitMinor: line.debitMinor, creditMinor: line.creditMinor, reversal: isReversal,
          });
        }
      }
    }
    return out;
  });
}

const refusal = (promise: Promise<unknown>) => promise.then(() => "NO_REFUSAL", (e: unknown) => String((e as Error).message));

describe("SCRUM-54 - a finance-company receipt names the physical bank", () => {
  test.each([
    ["MANUAL", "BANK_TRANSFER"],
    ["CONFIGURED", "BANK_TRANSFER"],
    ["CONFIGURED", "CHEQUE"],
  ] as const)("%s route, %s: omitting the bank is refused before any write", async (route, method) => {
    const { s, applicationId } = await finalizedDeal(`miss_${route}_${method}`, method, route);
    await insertBank(s); // the only bank: it must NOT be defaulted
    const before = await effects(s, applicationId);
    expect(await refusal(confirmWith(s, applicationId))).toMatch(/bank account/i);
    expect(await effects(s, applicationId)).toEqual(before);
  });

  test.each([
    [
      "another organization's bank",
      async (s: Seeded) => {
        const otherOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
        return await insertBank(s, { orgId: otherOrg });
      },
      /not found/i,
    ],
    ["a bank in another currency", (s: Seeded) => insertBank(s, { currency: "USD" }), /denominated in USD/i],
    ["an inactive bank", (s: Seeded) => insertBank(s, { isActive: false }), /inactive/i],
    ["a deleted bank", (s: Seeded) => insertBank(s, { isDeleted: true }), /not found/i],
  ] as const)("%s is refused before any write", async (_label, makeBank, message) => {
    const { s, applicationId } = await finalizedDeal("bad", "BANK_TRANSFER", "MANUAL");
    const bankAccountId = await makeBank(s);
    const before = await effects(s, applicationId);
    expect(await refusal(confirmWith(s, applicationId, bankAccountId))).toMatch(message);
    expect(await effects(s, applicationId)).toEqual(before);
  });

  test.each([
    ["MANUAL", "BANK_TRANSFER"],
    ["CONFIGURED", "BANK_TRANSFER"],
    ["CONFIGURED", "CHEQUE"],
  ] as const)("%s route, %s: the BANK_ACCOUNT line and the event payload carry the chosen bank, and only that line", async (route, method) => {
    const { s, applicationId } = await finalizedDeal(`ok_${route}_${method}`, method, route);
    await insertBank(s); // a decoy: the chosen bank is the second one
    const chosen = await insertBank(s);
    await confirmWith(s, applicationId, chosen);

    const lines = await receiptLines(s);
    expect(lines.find((l) => l.key === "BANK_ACCOUNT")).toMatchObject({ bankAccountId: chosen, debitMinor: G });
    expect(lines.filter((l) => l.key !== "BANK_ACCOUNT").every((l) => l.bankAccountId === undefined)).toBe(true);
    const event = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_CASH_RECEIVED"
      )
    );
    expect((event?.payload as { bankAccountId?: string }).bankAccountId).toBe(chosen);
  });

  test("CASH stays cash on hand: no bank is needed, and none is accepted", async () => {
    const { s, applicationId } = await finalizedDeal("cash", "CASH", "MANUAL");
    const bank = await insertBank(s);
    const before = await effects(s, applicationId);
    expect(await refusal(confirmWith(s, applicationId, bank))).toMatch(/cash/i);
    expect(await effects(s, applicationId)).toEqual(before);

    await confirmWith(s, applicationId);
    const lines = await receiptLines(s);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")).toMatchObject({ debitMinor: G });
    expect(lines.some((l) => l.key === "BANK_ACCOUNT")).toBe(false);
    expect(lines.every((l) => l.bankAccountId === undefined)).toBe(true);
  });

  test("a receipt queued for an unmapped bank account keeps the chosen bank and posts it once drained", async () => {
    const { s, applicationId } = await finalizedDeal("queued", "BANK_TRANSFER", "MANUAL");
    const chosen = await insertBank(s);
    const bankAccounts = await s.t.run(async (ctx) =>
      await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "BANK_ACCOUNT"))
        .collect()
    );
    await s.t.run(async (ctx) => {
      for (const a of bankAccounts) await ctx.db.patch(a._id, { active: false });
    });

    await confirmWith(s, applicationId, chosen);
    const pending = await s.t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").collect()).filter((p) => p.eventType === "FINANCE_CASH_RECEIVED")
    );
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as { bankAccountId?: string }).bankAccountId).toBe(chosen);

    await s.t.run(async (ctx) => {
      for (const a of bankAccounts) await ctx.db.patch(a._id, { active: true });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect((await receiptLines(s)).find((l) => l.key === "BANK_ACCOUNT")).toMatchObject({ bankAccountId: chosen, debitMinor: G });
  });

  test("the cheque-return reversal returns the money to the SAME bank", async () => {
    const { s, applicationId } = await finalizedDeal("rev", "CHEQUE", "CONFIGURED");
    await insertBank(s);
    const chosen = await insertBank(s);
    await confirmWith(s, applicationId, chosen);
    const cheque = (await effects(s, applicationId)).cheques.find((c) => c.status === "CLEARED")!;
    await s.owner.mutation(api.applications.returnFinanceDisbursementCheque, {
      orgId: s.orgId, applicationId, chequeId: cheque._id, returnReason: "Bank returned: insufficient funds",
      idempotencyKey: crypto.randomUUID(),
    });

    const bankLines = (await receiptLines(s)).filter((l) => l.key === "BANK_ACCOUNT");
    const reversal = bankLines.filter((l) => l.reversal);
    expect(reversal).toHaveLength(1);
    expect(reversal[0]).toMatchObject({ bankAccountId: chosen, creditMinor: G });
    expect(bankLines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0)).toBe(0);
  });

  test("the dialog's bank options are this org's active banks in the receivable's currency, and none for CASH", async () => {
    const { s, applicationId } = await finalizedDeal("opts", "BANK_TRANSFER", "MANUAL");
    const ok = await insertBank(s);
    await insertBank(s, { currency: "USD" });
    await insertBank(s, { isActive: false });
    await insertBank(s, { isDeleted: true });
    const otherOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
    await insertBank(s, { orgId: otherOrg });

    const options = await s.owner.query(api.applications.listDisbursementBankOptions, { orgId: s.orgId, applicationId });
    expect(options.needsBank).toBe(true);
    expect(options.banks.map((b) => b._id)).toEqual([ok]);
    expect(options.banks[0]).not.toHaveProperty("iban");
    expect(options.truncated).toBe(false);

    const cash = await finalizedDeal("optscash", "CASH", "MANUAL");
    expect(
      await cash.s.owner.query(api.applications.listDisbursementBankOptions, { orgId: cash.s.orgId, applicationId: cash.applicationId })
    ).toEqual({ needsBank: false, banks: [], truncated: false, receivableMissing: false });
    expect(options.receivableMissing).toBe(false);
  });

  test("more than 100 banks in other currencies never hide or truncate the eligible bank; more than 100 eligible banks report truncation, never a partial list", async () => {
    const { s, applicationId } = await finalizedDeal("optstrunc", "BANK_TRANSFER", "MANUAL");
    const insertMany = (count: number, currency: string) =>
      s.t.run(async (ctx) => {
        const now = Date.now();
        for (let i = 0; i < count; i++) {
          await ctx.db.insert("bankAccounts", {
            orgId: s.orgId, name: `Bulk ${currency} ${i}`, currency, openingBalanceMinor: 0, openingBalanceDate: now,
            isActive: true, isReconciliationTarget: false, createdBy: s.ownerUser, createdAt: now, updatedAt: now,
          });
        }
      });
    // 150 active USD banks (created first, so they precede the eligible one) must not crowd it out.
    await insertMany(150, "USD");
    const eligible = await insertBank(s);
    const foreignHeavy = await s.owner.query(api.applications.listDisbursementBankOptions, { orgId: s.orgId, applicationId });
    expect(foreignHeavy.truncated).toBe(false);
    expect(foreignHeavy.banks.map((b) => b._id)).toEqual([eligible]);

    // Exactly 100 eligible banks are still listed in full.
    await insertMany(99, "JOD");
    const atLimit = await s.owner.query(api.applications.listDisbursementBankOptions, { orgId: s.orgId, applicationId });
    expect(atLimit.truncated).toBe(false);
    expect(atLimit.banks).toHaveLength(100);

    // One more eligible bank passes what can be read: truncated with no banks, never a partial list.
    await insertMany(1, "JOD");
    const overLimit = await s.owner.query(api.applications.listDisbursementBankOptions, { orgId: s.orgId, applicationId });
    expect(overLimit).toEqual({ needsBank: true, banks: [], truncated: true, receivableMissing: false });
  });

  test("a bank receipt with no finance-company receivable reports it missing - never 'no eligible bank' - while CASH never looks", async () => {
    const { s, applicationId } = await finalizedDeal("optsnorcv", "BANK_TRANSFER", "MANUAL");
    await insertBank(s);
    const dropReceivable = (t: Seeded["t"], orgId: Id<"organizations">, appId: Id<"financeApplications">) =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query("receivableDocuments")
          .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "finance_application").eq("sourceId", appId))
          .take(5);
        for (const row of rows) await ctx.db.delete(row._id);
        return rows.length;
      });
    expect(await dropReceivable(s.t, s.orgId, applicationId)).toBe(1);
    expect(await s.owner.query(api.applications.listDisbursementBankOptions, { orgId: s.orgId, applicationId })).toEqual({
      needsBank: true, banks: [], truncated: false, receivableMissing: true,
    });

    const cash = await finalizedDeal("optscashnorcv", "CASH", "MANUAL");
    await insertBank(cash.s);
    expect(await dropReceivable(cash.s.t, cash.s.orgId, cash.applicationId)).toBe(1);
    expect(
      await cash.s.owner.query(api.applications.listDisbursementBankOptions, { orgId: cash.s.orgId, applicationId: cash.applicationId })
    ).toEqual({ needsBank: false, banks: [], truncated: false, receivableMissing: false });
  });

  test("a retry with the same key and bank replays; the same key with a different bank is refused", async () => {
    const { s, applicationId } = await finalizedDeal("retry", "BANK_TRANSFER", "MANUAL");
    const first = await insertBank(s);
    const second = await insertBank(s);
    const key = crypto.randomUUID();
    await confirmWith(s, applicationId, first, key);
    const afterFirst = await effects(s, applicationId);

    await confirmWith(s, applicationId, first, key);
    expect(await effects(s, applicationId)).toEqual(afterFirst);

    expect(await refusal(confirmWith(s, applicationId, second, key))).toContain(
      "Idempotency key reused with different request content. Use a new key for a different operation."
    );
    expect(await effects(s, applicationId)).toEqual(afterFirst);
    expect((await receiptLines(s)).filter((l) => l.key === "BANK_ACCOUNT").map((l) => l.bankAccountId)).toEqual([first]);
  });
});

// RT11-DOORS: historical lifecycle mechanics with the pilot doors explicitly open.
// Shipped-state refusals and controls live in rt11DoorContainment.test.ts.
vi.mock("./utils/rt11DoorContainment", async (importOriginal) =>
  (await import("../test-utils/rt11DoorSwitches")).openRt11Doors(
    await importOriginal<typeof import("./utils/rt11DoorContainment")>()
  ));
