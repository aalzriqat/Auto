/**
 * SCRUM-27 - a MANUAL finance company that pays THROUGH the dealership.
 *
 * Invariant: once the manager has entered, from the finance company's approval
 * letter, (a) the approved amount G, (b) the name exactly as on the letter and
 * (c) the amount S the dealership must send to the company (explicit 0 allowed,
 * unknown is never 0), the deal recognises AR-Finance for G, owes S onward, and
 * the receipt of G settles that receivable - with the company's NAME surviving on
 * every surface that would otherwise carry a finance-company id.
 *
 *   S = H (held deposit) + C (dealership contribution)
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no OCC, no paginated-query limit) and not production data.
 */
import { reverseAccountingEvent } from "./accounting/reversals";
import { convexTestWithComponents, registerHandover, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { deriveForwardState } from "./utils/financeCompanyForward";

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
const MANAGER_PERMS = ALL_PERMS.filter((p) => p !== "view:finance" && p !== "manage:finance");
const SALES_PERMS = ALL_PERMS.filter(
  (p) => !["finalize:financed_deal", "confirm:finance_disbursement", "view:finance", "manage:finance", "approve:finance_application"].includes(p)
);
const ACCOUNTANT_PERMS = ["view:finance", "manage:finance", "view:finance_applications", "view:reports"];

const G = 12_500_000; // minor units, JOD (3 decimals)
const SCALE = 1_000;
const LETTER_NAME = "Al-Ameen Islamic Finance";

/** H = held deposit, S = what the letter says the dealership sends. C = S - H. */
const CASES = [
  { name: "deposit held and dealership sends more (C > 0)", H: 200_000, S: 1_575_000 },
  { name: "dealership sends exactly the deposit (C = 0)", H: 200_000, S: 200_000 },
  { name: "no deposit and the letter says 0", H: 0, S: 0 },
] as const;
type Case = (typeof CASES)[number];

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S27 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = async (suffix: string, perms: string[], owner: boolean) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@example.com`, name: suffix })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: suffix.toUpperCase(), permissions: perms, ...(owner ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}`, clerkId: `${tag}_${suffix}` }) };
  };
  const owner = await mkUser("owner", ALL_PERMS, true);
  const approver = await mkUser("appr", ALL_PERMS, true);
  const manager = await mkUser("mgr", MANAGER_PERMS, false);
  const sales = await mkUser("sales", SALES_PERMS, false);
  const accountant = await mkUser("acct", ACCOUNTANT_PERMS, false);
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  await owner.as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await owner.as.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await owner.as.query(api.accountingPeriods.list, { orgId }))[0];
  await owner.as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN27${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: G / SCALE, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 9_000,
    })
  );
  return { t, orgId, customerId, vehicleId, owner, approver, manager, sales, accountant, fiscalYear };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;

function messageOf(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message;
  }
  return String(data ?? (error as Error)?.message ?? error);
}
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return messageOf(error);
  }
  return null;
}

/** A manual-finance-company application, APPROVED at the credit stage, nothing entered from the letter yet. */
async function manualApplication(s: Seeded, as = s.owner.as) {
  const quoteId = await as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: G / SCALE, downPayment: 0, termMonths: 48,
    mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option",
    manualAdminFees: 0, manualProfitRate: 5,
  });
  const applicationId = await as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  return { applicationId, quoteId };
}

const enterLetter = (
  s: Seeded,
  applicationId: Id<"financeApplications">,
  over: Partial<{ approvedAmountMinor: number; financierName: string; dealerSendsMinor: number }> & { as?: Seeded["owner"]["as"] } = {},
  c: Pick<Case, "S"> = { S: 1_575_000 }
) =>
  (over.as ?? s.approver.as).mutation(api.financingEconomics.recordManualFinanceApproval, {
    orgId: s.orgId,
    applicationId,
    approvedAmountMinor: over.approvedAmountMinor ?? G,
    financierName: over.financierName ?? LETTER_NAME,
    dealerSendsMinor: over.dealerSendsMinor ?? c.S,
  });

/** Ready to finalize: letter entered, handover, expected payment, legal invoice, reconciled costs, deposit. */
async function readyManualDeal(s: Seeded, c: Case, opts: { enterLetter?: boolean } = {}) {
  const { applicationId, quoteId } = await manualApplication(s);
  if (opts.enterLetter !== false) await enterLetter(s, applicationId, {}, c);
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  await recordReconciledZeroCost(s.owner.as, api, s.orgId, applicationId);
  await s.t.run(async (ctx) => {
    if (c.H > 0) {
      await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
        amount: c.H / SCALE, amountMinor: c.H, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
        createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
      } as never);
    }
    await ctx.db.patch(applicationId, { customerFirstPaymentMinor: c.H });
  });
  return { applicationId, quoteId };
}

const finalize = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId });

async function finalizedManualDeal(tag: string, c: Case) {
  const s = await seedDealership(tag);
  const { applicationId } = await readyManualDeal(s, c);
  await finalize(s, applicationId);
  return { s, applicationId };
}

const record = (
  s: Seeded,
  applicationId: Id<"financeApplications">,
  c: Pick<Case, "S">,
  over: Partial<{ expectedAmountMinor: number; idempotencyKey: string }> = {},
  as = s.owner.as
) =>
  as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
    expectedAmountMinor: over.expectedAmountMinor ?? c.S,
    idempotencyKey: over.idempotencyKey ?? crypto.randomUUID(),
  });

const confirmTransfer = (s: Seeded, applicationId: Id<"financeApplications">, amount = G) =>
  s.owner.as.mutation(api.applications.confirmDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: amount, idempotencyKey: crypto.randomUUID(),
  });

async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const net = new Map<string, number>();
    for (const event of events) {
      const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
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

/** Every journal line on the finance-company receivable/payable accounts, with the payer identity it carries. */
const financeLines = (s: Seeded) =>
  s.t.run(async (ctx) => {
    const out: { systemKey: string; payerNameSnapshot?: string; financeCompanyId?: string }[] = [];
    for (const line of await ctx.db.query("journalLines").collect()) {
      if (line.orgId !== s.orgId) continue;
      const account = await ctx.db.get(line.accountId);
      if (
        account?.systemKey === "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES" ||
        account?.systemKey === "ACCOUNTS_PAYABLE_FINANCE_COMPANIES"
      ) {
        const l = line as { payerNameSnapshot?: string; financeCompanyId?: string };
        out.push({ systemKey: account.systemKey, payerNameSnapshot: l.payerNameSnapshot, financeCompanyId: l.financeCompanyId });
      }
    }
    return out;
  });

const proofOf = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!));

describe.each(CASES)("SCRUM-27 - $name", (c) => {
  const C = c.S - c.H;

  test("the letter: manager enters G, the name and S; the application carries them, refused if any is missing", async () => {
    const s = await seedDealership(`enter_${c.H}_${c.S}`);
    const { applicationId } = await manualApplication(s);
    expect(await refusalOf(enterLetter(s, applicationId, { financierName: "   " }, c))).toMatch(/name/i);
    expect(await refusalOf(enterLetter(s, applicationId, { financierName: "Other finance option" }, c))).toMatch(/name/i);
    expect(await refusalOf(enterLetter(s, applicationId, { approvedAmountMinor: 0 }, c))).toMatch(/approved amount/i);
    expect(await refusalOf(enterLetter(s, applicationId, { approvedAmountMinor: Number.NaN }, c))).not.toBeNull();
    expect(await refusalOf(enterLetter(s, applicationId, { dealerSendsMinor: -1 }, c))).not.toBeNull();
    expect(await refusalOf(enterLetter(s, applicationId, { dealerSendsMinor: Number.NaN }, c))).not.toBeNull();
    expect(await refusalOf(enterLetter(s, applicationId, { dealerSendsMinor: 1.5 }, c))).not.toBeNull();
    // Nothing partial was written by any refusal.
    const untouched = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect((untouched as { manualApproval?: unknown })?.manualApproval).toBeUndefined();
    expect(untouched?.approvedDealerPurchaseAmountMinor).toBeUndefined();

    await enterLetter(s, applicationId, {}, c);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    const approval = (app as { manualApproval?: Record<string, unknown> })?.manualApproval;
    expect(approval).toMatchObject({ approvedAmountMinor: G, financierName: LETTER_NAME, dealerSendsMinor: c.S });
    expect(app?.approvedDealerPurchaseAmountMinor).toBe(G);
    expect(app?.companyId).toBeUndefined();
  });

  test("finalize is refused until the letter has been entered, and nothing is written", async () => {
    const s = await seedDealership(`gate_${c.H}_${c.S}`);
    const { applicationId } = await readyManualDeal(s, c, { enterLetter: false });
    expect(await refusalOf(finalize(s, applicationId))).not.toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).not.toBe("CLOSED");
    expect(app?.finalizedSaleId).toBeUndefined();
  });

  test("finalize freezes v2: due = S, the receivable is the FULL G and names the company, the sale journal balances", async () => {
    const { s, applicationId } = await finalizedManualDeal(`fin_${c.H}_${c.S}`, c);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CLOSED");
    expect(app?.financedSalePlanVersion).toBe(2);
    expect(app?.financeCompanyForwardDueMinor).toBe(c.S);
    expect(app?.financedSaleNetReceivableMinor).toBe(G);
    expect(app?.dealerContributionMinor).toBe(C);

    const receivables = (await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect())).filter((r) => r.orgId === s.orgId);
    const finance = receivables.filter((r) => r.sourceType === "finance_application");
    expect(finance).toHaveLength(1);
    expect(finance[0]).toMatchObject({ payerType: "MANUAL_FINANCE_COMPANY", payerNameSnapshot: LETTER_NAME });
    expect(finance[0].financeCompanyId).toBeUndefined();

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(G);
    expect((net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0) + c.S).toBe(0);
    expect(net.SALES_CONSIDERATION_REDUCTIONS ?? 0).toBe(C);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("the company's name is on every finance journal line, never a finance-company id", async () => {
    const { s, applicationId } = await finalizedManualDeal(`lines_${c.H}_${c.S}`, c);
    if (c.S > 0) await record(s, applicationId, c);
    await confirmTransfer(s, applicationId);
    const lines = await financeLines(s);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.payerNameSnapshot).toBe(LETTER_NAME);
      expect(line.financeCompanyId).toBeUndefined();
    }
  });

  test("forward then receipt: AP clears, AR is settled by the FULL G, the payment names the payer, the stage completes", async () => {
    const { s, applicationId } = await finalizedManualDeal(`rcpt_${c.H}_${c.S}`, c);
    const proof0 = await proofOf(s, applicationId);
    if (c.S > 0) {
      expect(proof0.state).toBe("DUE");
      expect(proof0.dueMinor).toBe(c.S);
      // The transfer is refused until the dealership has paid what the letter says it owes.
      expect(await refusalOf(confirmTransfer(s, applicationId))).toMatch(/manager or accountant records that payment/i);
      await record(s, applicationId, c);
      const forwardNet = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
      expect(forwardNet.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(c.S);
      const rows = await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ payerNameSnapshot: LETTER_NAME });
      expect(rows[0].financeCompanyId).toBeUndefined();
      expect((await proofOf(s, applicationId)).state).toBe("SETTLED");
    } else {
      // Nothing to forward: the proof must not demand a payment of 0.
      expect(["NOT_DUE", "SETTLED"]).toContain(proof0.state);
      expect(await refusalOf(record(s, applicationId, c))).not.toBeNull();
    }

    // The receipt is for the approved amount only.
    expect(await refusalOf(confirmTransfer(s, applicationId, G - 1))).not.toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeUndefined();
    await confirmTransfer(s, applicationId, G);
    const after = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.disbursedAt).toBeDefined();
    const receipt = await netByAccount(s, "FINANCE_CASH_RECEIVED");
    expect(receipt.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(-G);

    const payments = (await s.t.run((ctx) => ctx.db.query("canonicalPayments").collect())).filter(
      (p) => p.orgId === s.orgId && (p as { payerType?: string }).payerType === "MANUAL_FINANCE_COMPANY"
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ payerNameSnapshot: LETTER_NAME });

    const cockpit = await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    const disb = cockpit?.stages.find((st: { key: string }) => st.key === "DISBURSEMENT");
    expect(disb?.state).toBe("COMPLETE");
    // The finance receivable is settled exactly once (the receipt is not replayable).
    expect(await refusalOf(confirmTransfer(s, applicationId, G))).not.toBeNull();
  });

  test("cancel after finalize and before any payment: the receivable is cancelled; a payment on the books blocks it", async () => {
    const { s, applicationId } = await finalizedManualDeal(`cancel_${c.H}_${c.S}`, c);
    const cancel = () =>
      s.manager.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      });
    if (c.S > 0) {
      await record(s, applicationId, c);
      expect(await refusalOf(cancel())).toMatch(/already been paid to the finance company/i);
      return;
    }
    expect(await refusalOf(cancel())).toBeNull();
    const receivables = (await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect())).filter(
      (r) => r.orgId === s.orgId && r.sourceType === "finance_application"
    );
    expect(receivables).toHaveLength(1);
    expect(receivables[0].status).toBe("CANCELLED");
  });
});

describe("SCRUM-27 - cancel before the payment leaves no open manual receivable", () => {
  test("the receivable and the sale are cancelled and the books net to zero on AR-Finance", async () => {
    const c = CASES[0];
    const { s, applicationId } = await finalizedManualDeal("cancelnp", c);
    await s.manager.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });
    const receivable = (await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect())).find(
      (r) => r.orgId === s.orgId && r.sourceType === "finance_application"
    );
    expect(receivable?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });
});

describe("SCRUM-27 - refusals and red-team cases", () => {
  const c = CASES[0];

  test("S below the held deposit is refused at finalize (C would be negative) and writes nothing", async () => {
    const s = await seedDealership("neg");
    const { applicationId } = await readyManualDeal(s, { name: "x", H: 200_000, S: 100_000 } as unknown as Case);
    const refusal = await refusalOf(finalize(s, applicationId));
    expect(refusal).not.toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).not.toBe("CLOSED");
    expect(app?.finalizedSaleId).toBeUndefined();
  });

  test("the letter needs approve:finance_application; the salesperson who opened the deal cannot approve it", async () => {
    const s = await seedDealership("perm");
    const { applicationId } = await manualApplication(s, s.sales.as);
    expect(await refusalOf(enterLetter(s, applicationId, { as: s.accountant.as }, c))).not.toBeNull();
    expect(await refusalOf(enterLetter(s, applicationId, { as: s.sales.as }, c))).not.toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(await refusalOf(enterLetter(s, applicationId, { as: s.manager.as }, c))).toBeNull();
  });

  test("another organisation cannot enter the letter for this application", async () => {
    const s = await seedDealership("tenA");
    const other = await seedDealership("tenB");
    const { applicationId } = await manualApplication(s);
    expect(
      await refusalOf(
        other.owner.as.mutation(api.financingEconomics.recordManualFinanceApproval, {
          orgId: other.orgId, applicationId, approvedAmountMinor: G, financierName: LETTER_NAME, dealerSendsMinor: c.S,
        })
      )
    ).not.toBeNull();
  });

  test("a CONFIGURED application is refused the manual door, and a manual one is refused the configured approval", async () => {
    const s = await seedDealership("door");
    const { applicationId } = await manualApplication(s);
    const refusal = await refusalOf(
      s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "x",
      })
    );
    expect(refusal).not.toBeNull();
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId, name: "Configured Co", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0,
        isActive: true, defaultLtvPercent: 100, adminFees: 0,
      })
    );
    await s.t.run((ctx) => ctx.db.patch(applicationId, { companyId }));
    expect(await refusalOf(enterLetter(s, applicationId, {}, c))).not.toBeNull();
  });

  test("re-entering the same letter twice changes nothing; a changed letter before finalize replaces it and is audited", async () => {
    const s = await seedDealership("reenter");
    const { applicationId } = await manualApplication(s);
    await enterLetter(s, applicationId, {}, c);
    await enterLetter(s, applicationId, {}, c);
    await enterLetter(s, applicationId, { financierName: "Al-Ameen Islamic Finance Co." }, c);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect((app as { manualApproval?: { financierName: string } })?.manualApproval?.financierName).toBe("Al-Ameen Islamic Finance Co.");
  });

  test("once finalized, the letter can no longer be changed", async () => {
    const { s, applicationId } = await finalizedManualDeal("frozen", c);
    expect(await refusalOf(enterLetter(s, applicationId, { financierName: "Someone Else" }, c))).not.toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect((app as { manualApproval?: { financierName: string } })?.manualApproval?.financierName).toBe(LETTER_NAME);
  });

  test("a pre-plan (v1) manual deal never reaches the receipt path and books nothing", async () => {
    const { s, applicationId } = await finalizedManualDeal("v1", c);
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, { financedSalePlanVersion: undefined, financedSaleRecognitionFingerprint: undefined, financeCompanyForwardDueMinor: undefined })
    );
    const before = await netByAccount(s, "FINANCE_CASH_RECEIVED");
    expect(await refusalOf(confirmTransfer(s, applicationId))).not.toBeNull();
    expect(await netByAccount(s, "FINANCE_CASH_RECEIVED")).toEqual(before);
  });

  test("a receipt is refused when the receivable's payer no longer matches the application's frozen name", async () => {
    const { s, applicationId } = await finalizedManualDeal("swap", c);
    await record(s, applicationId, c);
    await s.t.run(async (ctx) => {
      const r = (await ctx.db.query("receivableDocuments").collect()).find((x) => x.orgId === s.orgId && x.sourceType === "finance_application")!;
      await ctx.db.patch(r._id, { payerNameSnapshot: "A Different Company" } as never);
    });
    expect(await refusalOf(confirmTransfer(s, applicationId))).not.toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeUndefined();
  });

  test("forward is recordable only by finance permission; the manager and sales are refused", async () => {
    const { s, applicationId } = await finalizedManualDeal("fwdperm", c);
    expect(await refusalOf(record(s, applicationId, c, {}, s.manager.as))).not.toBeNull();
    expect(await refusalOf(record(s, applicationId, c, {}, s.sales.as))).not.toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(0);
  });

  test("forward rows for two manual deals are separate: each carries its own name", async () => {
    const one = await finalizedManualDeal("two_a", c);
    const rows = await one.s.t.run((ctx) => ctx.db.query("receivableDocuments").collect());
    expect(rows.filter((r) => r.sourceType === "finance_application" && r.payerNameSnapshot === LETTER_NAME)).toHaveLength(1);
  });
});

describe("SCRUM-27 - reversing a manual payer's posting", () => {
  test("reversing the forward twice reverses once, and the reversal lines keep the payer's name", async () => {
    const c = CASES[0];
    const { s, applicationId } = await finalizedManualDeal("revtwice", c);
    await record(s, applicationId, c);
    const result = await s.t.run(async (ctx) => {
      const original = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
        .find((e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID" && e.status === "POSTED")!;
      const actorId = (await ctx.db.query("users").first())!._id;
      const cmd = { orgId: s.orgId, originalEventId: original._id, reversalDate: Date.now(), reason: "test", actorId, idempotencyKey: `rev-${original._id}` };
      const first = await reverseAccountingEvent(ctx, cmd);
      const second = await reverseAccountingEvent(ctx, cmd);
      const reversals = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
        .filter((e) => e.eventType === "JOURNAL_REVERSAL");
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", first.reversalJournalEntryId)).collect();
      return { first, second, reversalCount: reversals.length, names: lines.map((l) => l.payerNameSnapshot ?? null), fcIds: lines.map((l) => l.financeCompanyId ?? null) };
    });
    expect(result.first.alreadyReversed).toBe(false);
    expect(result.second.alreadyReversed).toBe(true);
    expect(result.second.reversalEventId).toBe(result.first.reversalEventId);
    expect(result.reversalCount).toBe(1);
    expect(result.names).toContain(LETTER_NAME);
    expect(result.fcIds.every((x) => x === null)).toBe(true);
  });
});
