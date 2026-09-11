/**
 * SCRUM-241 — the finance-company receipt is settled against the EXACT
 * recorded receivable, in ITS currency and scale, or not at all.
 *
 * Owner-proxy contract (SCRUM-241 c19230, SCRUM-313 c19303): before any
 * disbursement / cheque / payment / allocation / posting write, the live
 * finance-company receivable and the frozen recognition figure are loaded
 * server-side and must agree with each other and with the caller; one proved
 * amount/currency then drives the accounting event, the canonical payment and
 * the allocation. A later organisation-default currency change neither
 * relabels an unchanged integer nor decides a historical debt's denomination.
 * Incompatible inputs are refused BEFORE finalization creates a sale.
 *
 * Fixture lineage: the seed and walk helpers are taken from the Unified Deal
 * lane's executed reproduction (`convex/sn31CurrencyMismatchRepro.test.ts` at
 * PR #301 `b5baaa213`, SCRUM-241 c19265), which established reachability with
 * a healthy control. The cases here are the proof list the ruling names.
 *
 * Evidence boundary: convex-test only — repository behaviour, not the Convex
 * runtime, not production data.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
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

const VEHICLE_PRICE = 20_000;
const PURCHASE_PRICE = 15_000;
/** JOD and KWD: three decimals. USD: two. */
const JOD_SCALE = 1_000;

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `S241 ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Deal User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.appr@example.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  const asApprover = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN241${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: PURCHASE_PRICE,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100,
    })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, companyId, asUser, asApprover };
}

type Seeded = Awaited<ReturnType<typeof seedDealership>>;

/** Walks a through-dealership financed deal to APPROVED with its economics PINNED (JOD). */
async function approvedDealWithPinnedEconomics(s: Seeded) {
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId,
    totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  await s.asUser.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
  });
  await s.asApprover.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "APPROVED",
  });
  await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId,
    applicationId,
    submittedQuotationMinor: VEHICLE_PRICE * JOD_SCALE,
    source: "MANUAL_ENTRY",
  });
  await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId,
    applicationId,
    approvedAmountMinor: VEHICLE_PRICE * JOD_SCALE,
    basis: "MANUAL",
    notes: "Approved at the quotation.",
  });
  return { quoteId, applicationId };
}

/** Handover → expected payment → invoice/fee/classification. Stops short of finalizeDeal. */
async function prepareForFinalize(
  s: Seeded,
  applicationId: Id<"financeApplications">,
  fee: { withheldMinor: number } = { withheldMinor: 0 }
) {
  await registerHandover(s.asUser, api, s.orgId, applicationId);
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId,
    applicationId,
    legalInvoiceAmountMinor: VEHICLE_PRICE * JOD_SCALE,
    legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(),
    issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, {
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
    feeType: fee.withheldMinor > 0 ? "LICENSING" : "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: fee.withheldMinor > 0 ? "FINANCE_COMPANY" : "OTHER",
    accountingTreatment: fee.withheldMinor > 0 ? "FINANCE_COMPANY_COMMISSION" : "SELLING_EXPENSE",
    deductedFromSettlement: fee.withheldMinor > 0,
    actualAmountMinor: fee.withheldMinor,
    description: fee.withheldMinor > 0 ? "Withheld by the company." : "No closing costs.",
  });
  await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.",
  });
  await s.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
    orgId: s.orgId,
    applicationId,
    notes: "Invoice and settlement advice on file.",
  });
}

async function finalize(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.asUser.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
  });
}

async function app(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

/** Everything finalization and settlement commit, counted from the tables themselves. */
async function economicDelta(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const receivables = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
      .collect();
    const receivable = receivables.find(
      (r) => r.sourceType === "finance_application" && r.sourceId === applicationId
    );
    const payments = (
      await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
    ).filter((p) => p.payerType === "FINANCE_COMPANY");
    const allocations = receivable
      ? await ctx.db
          .query("paymentAllocations")
          .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivable._id))
          .collect()
      : [];
    const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const cashReceived = events.filter((e) => e.eventType === "FINANCE_CASH_RECEIVED");
    const sales = await ctx.db.query("sales").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const journals = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return {
      receivable: receivable
        ? {
            currency: receivable.currency,
            scale: receivable.scale,
            status: receivable.status,
            originalAmountMinor: receivable.originalAmountMinor,
          }
        : null,
      financeCompanyPayments: payments.map((p) => ({ currency: p.currency, amountMinor: p.amountMinor, scale: p.scale })),
      allocations: allocations.map((a) => ({ amountMinor: a.amountMinor, status: a.status })),
      cashReceivedEvents: cashReceived.map((e) => ({ currency: e.currency, amountMinor: (e.payload as { amountMinor?: number })?.amountMinor })),
      sales: sales.length,
      journals: journals.length,
    };
  });
}

async function switchOrgCurrencyViaProduct(s: Seeded, currency: "USD" | "JOD" | "KWD") {
  return await s.asUser.mutation(api.orgSettings.upsert, {
    orgId: s.orgId,
    currency,
    currencySymbol: currency === "USD" ? "$" : currency === "KWD" ? "KD" : "JD",
  });
}

function messageOf(error: unknown) {
  return String((error as { data?: unknown; message?: string })?.data ?? (error as Error)?.message ?? error);
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return messageOf(error);
  }
  return null;
}

describe("SCRUM-241 — finance-company receipt settles the exact recorded receivable in its own currency", () => {
  test("CONTROL — unchanged currency: one proved figure drives receivable, payment, allocation and FINANCE_CASH_RECEIVED", async () => {
    const s = await seedDealership("ctrl");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.financedSaleNetReceivableMinor).toBe(VEHICLE_PRICE * JOD_SCALE);

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
      idempotencyKey: "s241-ctrl",
    });

    const after = await economicDelta(s, applicationId);
    expect(after.receivable).toMatchObject({ currency: "JOD", scale: 3, status: "PAID", originalAmountMinor: VEHICLE_PRICE * JOD_SCALE });
    expect(after.financeCompanyPayments).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE, scale: 3 }]);
    expect(after.allocations).toEqual([{ amountMinor: VEHICLE_PRICE * JOD_SCALE, status: "ACTIVE" }]);
    expect(after.cashReceivedEvents).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE }]);
    expect((await app(s, applicationId))?.disbursedAmountMinor).toBe(VEHICLE_PRICE * JOD_SCALE);
  });

  test("WITHHELD FEE — the net the company actually remits is the figure; the customer's principal is refused", async () => {
    const s = await seedDealership("net");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    const withheld = 375 * JOD_SCALE;
    await prepareForFinalize(s, applicationId, { withheldMinor: withheld });
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    const net = VEHICLE_PRICE * JOD_SCALE - withheld;
    expect(closed?.financedSaleNetReceivableMinor).toBe(net);
    const before = await economicDelta(s, applicationId);
    expect(before.receivable).toMatchObject({ currency: "JOD", status: "OPEN", originalAmountMinor: net });

    const refusal = await refusalOf(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: VEHICLE_PRICE * JOD_SCALE,
        idempotencyKey: "s241-net-principal",
      })
    );
    expect(refusal).toMatch(/not what this financing company owes/i);
    expect(await economicDelta(s, applicationId)).toEqual(before);

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: net,
      idempotencyKey: "s241-net",
    });
    const after = await economicDelta(s, applicationId);
    expect(after.receivable).toMatchObject({ currency: "JOD", status: "PAID" });
    expect(after.financeCompanyPayments).toEqual([{ currency: "JOD", amountMinor: net, scale: 3 }]);
    expect(after.allocations).toEqual([{ amountMinor: net, status: "ACTIVE" }]);
    expect(after.cashReceivedEvents).toEqual([{ currency: "JOD", amountMinor: net }]);
  });

  test("BEFORE FINALIZATION, different scale (JOD→USD) — finalizeDeal refuses the incompatible denomination before any sale, receivable or journal exists", async () => {
    const s = await seedDealership("pre_usd");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    // The real product mutation succeeds here: a pinned application is not on
    // the currency lock's list and nothing financial exists yet (c19265 case 2).
    await switchOrgCurrencyViaProduct(s, "USD");
    expect((await app(s, applicationId))?.economicsCurrency).toBe("JOD");
    const before = await economicDelta(s, applicationId);
    expect(before.sales).toBe(0);
    expect(before.receivable).toBeNull();

    const refusal = await refusalOf(finalize(s, applicationId));
    expect(refusal).toMatch(/JOD/);
    expect(refusal).toMatch(/USD/);
    expect(refusal).toMatch(/currency/i);

    // Nothing was created: no sale, no receivable, no journal, status unchanged.
    expect(await economicDelta(s, applicationId)).toEqual(before);
    const still = await app(s, applicationId);
    expect(still?.status).toBe("APPROVED");
    expect(still?.finalizedSaleId).toBeUndefined();
  });

  test("BEFORE FINALIZATION, same scale (JOD→KWD, both 3 decimals) — still refused: denomination, not scale, is the contract", async () => {
    const s = await seedDealership("pre_kwd");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await switchOrgCurrencyViaProduct(s, "KWD");
    const before = await economicDelta(s, applicationId);

    const refusal = await refusalOf(finalize(s, applicationId));
    expect(refusal).toMatch(/JOD/);
    expect(refusal).toMatch(/KWD/);
    expect(await economicDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.status).toBe("APPROVED");
  });

  test("BEFORE FINALIZATION — switching back to the pinned currency makes the same deal finalize and settle normally", async () => {
    const s = await seedDealership("pre_back");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await switchOrgCurrencyViaProduct(s, "USD");
    expect(await refusalOf(finalize(s, applicationId))).toMatch(/currency/i);
    await switchOrgCurrencyViaProduct(s, "JOD");

    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    expect(closed?.status).toBe("CLOSED");
    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
      idempotencyKey: "s241-pre-back",
    });
    const after = await economicDelta(s, applicationId);
    expect(after.receivable).toMatchObject({ currency: "JOD", status: "PAID" });
    expect(after.cashReceivedEvents).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE }]);
  });

  test("AFTER FINALIZATION — the product lock still refuses an org currency change once the sale has posted", async () => {
    const s = await seedDealership("post_lock");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);

    await expect(switchOrgCurrencyViaProduct(s, "USD")).rejects.toThrow(
      /currency cannot be changed after financial records exist/i
    );
  });

  test("AFTER FINALIZATION, out-of-contract raw settings edit — the recorded JOD debt is settled in JOD; the org default decides nothing", async () => {
    const s = await seedDealership("post_raw");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    const before = await economicDelta(s, applicationId);
    expect(before.receivable).toMatchObject({ currency: "JOD", status: "OPEN" });

    // Not a product path — the lock above forbids it. A support/data-repair
    // analogue: the org's default currency now reads USD while the debt is JOD.
    await s.t.run(async (ctx) => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
      await ctx.db.patch(settings!._id, { currency: "USD", currencySymbol: "$" });
    });

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
      idempotencyKey: "s241-post-raw",
    });

    // Same-currency settlement of the existing debt: nothing is relabelled
    // USD, nothing is converted, the integer is the recorded one.
    const after = await economicDelta(s, applicationId);
    expect(after.receivable).toMatchObject({ currency: "JOD", scale: 3, status: "PAID" });
    expect(after.financeCompanyPayments).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE, scale: 3 }]);
    expect(after.allocations).toEqual([{ amountMinor: VEHICLE_PRICE * JOD_SCALE, status: "ACTIVE" }]);
    expect(after.cashReceivedEvents).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE }]);
  });

  test("CONTRADICTORY AUTHORITY — the live receivable disagrees with the frozen recognition figure: refused before any write", async () => {
    const s = await seedDealership("contra");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    // Corrupt lineage, not a product path: the subledger document no longer
    // carries what the sale recognised.
    await s.t.run(async (ctx) => {
      const receivable = (
        await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
      ).find((r) => r.sourceType === "finance_application" && r.sourceId === applicationId)!;
      await ctx.db.patch(receivable._id, { originalAmountMinor: receivable.originalAmountMinor - 1 });
    });
    const before = await economicDelta(s, applicationId);

    const refusal = await refusalOf(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
        idempotencyKey: "s241-contra",
      })
    );
    expect(refusal).toMatch(/does not match|disagree/i);
    expect(await economicDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });

  test("PRIOR ACTIVE ALLOCATION — a receivable already partly settled is refused, never reconciled with min()", async () => {
    const s = await seedDealership("prior");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    // Adversarial pre-existing allocation on the finance receivable.
    await s.t.run(async (ctx) => {
      const receivable = (
        await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
      ).find((r) => r.sourceType === "finance_application" && r.sourceId === applicationId)!;
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId: s.orgId,
        direction: "IN",
        payerType: "FINANCE_COMPANY",
        financeCompanyId: s.companyId,
        method: "BANK_TRANSFER",
        amountMinor: 1_000,
        currency: "JOD",
        scale: 3,
        status: "SETTLED",
        idempotencyKey: "prior-alloc",
        createdBy: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("paymentAllocations", {
        orgId: s.orgId,
        paymentId,
        receivableDocumentId: receivable._id,
        amountMinor: 1_000,
        currency: "JOD",
        scale: 3,
        allocationDate: Date.now(),
        status: "ACTIVE",
        createdBy: s.userId,
        createdAt: Date.now(),
      });
    });
    const before = await economicDelta(s, applicationId);

    const refusal = await refusalOf(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
        idempotencyKey: "s241-prior",
      })
    );
    expect(refusal).toMatch(/already/i);
    expect(await economicDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });

  test("MISSING RECEIVABLE — no live finance-company receivable for the deal: named refusal, nothing invented", async () => {
    const s = await seedDealership("missing");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    await s.t.run(async (ctx) => {
      const receivable = (
        await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
      ).find((r) => r.sourceType === "finance_application" && r.sourceId === applicationId)!;
      await ctx.db.delete(receivable._id);
    });
    const before = await economicDelta(s, applicationId);
    expect(before.receivable).toBeNull();

    const refusal = await refusalOf(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
        idempotencyKey: "s241-missing",
      })
    );
    expect(refusal).toMatch(/no finance-company receivable/i);
    expect(await economicDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });

  test("REPLAY — the same command identity settles once; a second receipt is not minted", async () => {
    const s = await seedDealership("replay");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await prepareForFinalize(s, applicationId);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    const args = {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
      idempotencyKey: "s241-replay",
    };
    await s.asUser.mutation(api.applications.confirmDisbursement, args);
    const once = await economicDelta(s, applicationId);
    await s.asUser.mutation(api.applications.confirmDisbursement, args);
    expect(await economicDelta(s, applicationId)).toEqual(once);
    expect(once.financeCompanyPayments).toHaveLength(1);
    expect(once.allocations).toHaveLength(1);
    expect(once.cashReceivedEvents).toHaveLength(1);
  });
});
