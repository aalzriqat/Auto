/**
 * SN3-1 reproduction — SCRUM-215 / SCRUM-241 (owner-proxy ruling 2026-09-11 10:50).
 *
 * Question: on a deal whose pinned `economicsCurrency` differs from the org's
 * CURRENT currency, what does `confirmDisbursement` actually do when handed
 * the frozen net (the figure the Unified Deal cockpit now sends), and did the
 * cockpit change make that boundary reachable?
 *
 * Executed, not reasoned: every case drives the real product mutations on
 * convex-test fixtures and asserts the committed delta afterwards.
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
/** JOD: three decimals. */
const JOD_SCALE = 1_000;
/** USD: two decimals. */
const USD_SCALE = 100;

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SN31 ${tag}`, createdAt: Date.now() })
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
  // The system owner role, so the real `orgSettings.upsert` (requireOwner) can
  // be driven for the currency change — the product path, not a raw patch.
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
      orgId, vin: `VINSN31${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
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

/** Walks a through-dealership financed deal to APPROVED with its economics PINNED. */
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
  // These pin `economicsCurrency` to the org currency as it stands NOW (JOD).
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

/** Handover → expected payment → invoice/fees/classification → finalizeDeal. */
async function finalize(s: Seeded, applicationId: Id<"financeApplications">) {
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
    orgId: s.orgId,
    applicationId,
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "No closing costs.",
  });
  await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Nothing to match.",
  });
  await s.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
    orgId: s.orgId,
    applicationId,
    notes: "Invoice and settlement advice on file.",
  });
  return await s.asUser.mutation(api.applications.finalizeDeal, {
    orgId: s.orgId,
    applicationId,
  });
}

async function app(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

/** Everything a confirmed disbursement commits, counted from the tables themselves. */
async function settlementDelta(s: Seeded, applicationId: Id<"financeApplications">) {
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
    const events = (
      await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
    ).filter((e) => e.eventType === "FINANCE_CASH_RECEIVED");
    return {
      receivable: receivable
        ? { currency: receivable.currency, status: receivable.status, originalAmountMinor: receivable.originalAmountMinor }
        : null,
      financeCompanyPayments: payments.map((p) => ({ currency: p.currency, amountMinor: p.amountMinor })),
      allocations: allocations.length,
      cashReceivedEvents: events.length,
    };
  });
}

async function switchOrgCurrencyViaProduct(s: Seeded, currency: "USD" | "JOD") {
  return await s.asUser.mutation(api.orgSettings.upsert, {
    orgId: s.orgId,
    currency,
    currencySymbol: currency === "USD" ? "$" : "JD",
  });
}

describe("SN3-1 — confirmDisbursement when the deal's pinned currency ≠ the org's current currency", () => {
  test("CONTROL — same currency throughout: the frozen net is accepted and settles the receivable in JOD", async () => {
    const s = await seedDealership("ctrl");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    expect((await app(s, applicationId))?.economicsCurrency).toBe("JOD");

    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.financedSaleNetReceivableMinor).toBe(VEHICLE_PRICE * JOD_SCALE);

    const before = await settlementDelta(s, applicationId);
    expect(before.receivable).toMatchObject({ currency: "JOD", status: "OPEN" });

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
      idempotencyKey: "sn31-ctrl",
    });

    const after = await settlementDelta(s, applicationId);
    expect((await app(s, applicationId))?.disbursedAt).toBeTypeOf("number");
    expect(after.receivable).toMatchObject({ currency: "JOD", status: "PAID" });
    expect(after.financeCompanyPayments).toEqual([{ currency: "JOD", amountMinor: VEHICLE_PRICE * JOD_SCALE }]);
    expect(after.allocations).toBe(1);
    expect(after.cashReceivedEvents).toBe(1);
  });

  test("BEFORE finalization — org switches JOD→USD after the economics were pinned: the product lock does NOT stop it", async () => {
    const s = await seedDealership("pre");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    expect((await app(s, applicationId))?.economicsCurrency).toBe("JOD");

    // The real product mutation. `orgSettings.upsert` locks currency only once
    // an accounting/transaction/journal/expense row exists — none does yet: a
    // pinned finance application is not on its list.
    await switchOrgCurrencyViaProduct(s, "USD");
    const settings = await s.t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()
    );
    expect(settings?.currency).toBe("USD");
    // The deal keeps its pin.
    expect((await app(s, applicationId))?.economicsCurrency).toBe("JOD");
  });

  test("BEFORE finalization — finalize then confirm the frozen net: the FIRST refusal is the currency assertion inside allocation, and nothing commits", async () => {
    const s = await seedDealership("pre2");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await switchOrgCurrencyViaProduct(s, "USD");

    // Finalization itself goes through: the plan is built in the PINNED
    // currency and the receivable is opened in it.
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.financedSaleNetReceivableMinor).toBe(VEHICLE_PRICE * JOD_SCALE);
    const before = await settlementDelta(s, applicationId);
    expect(before.receivable).toMatchObject({ currency: "JOD", status: "OPEN", originalAmountMinor: VEHICLE_PRICE * JOD_SCALE });
    expect(before.financeCompanyPayments).toEqual([]);
    expect(before.cashReceivedEvents).toBe(0);

    // The NEW caller (Unified Deal cockpit and the Review dialog after round 2)
    // sends the frozen net integer — the amount check passes — and the
    // posting builds receipt/payment in the org's CURRENT currency (USD).
    let refusal: unknown;
    try {
      await s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
        idempotencyKey: "sn31-pre2",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeDefined();
    const message = String((refusal as { data?: unknown; message?: string })?.data ?? (refusal as Error)?.message ?? refusal);
    console.log("SN3-1 first refusal (new caller, switch BEFORE finalize):", message);
    expect(message).toMatch(/currency/i);

    // Zero committed financial delta: the receivable is still OPEN in JOD,
    // no finance-company payment, no allocation, no FINANCE_CASH_RECEIVED
    // event, and the application is not marked disbursed.
    const after = await settlementDelta(s, applicationId);
    expect(after).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });

  test("ORIGIN — the OLD caller (principal at the org's current scale) was refused on the same deal too, one check earlier", async () => {
    const s = await seedDealership("old");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await switchOrgCurrencyViaProduct(s, "USD");
    await finalize(s, applicationId);
    const before = await settlementDelta(s, applicationId);

    // What the pre-round-2 clients sent: `quote.totalFinancedAmount` scaled by
    // the org's CURRENT currency factor — 20,000 × 100 under USD.
    const oldCallerAmount = VEHICLE_PRICE * USD_SCALE;
    let refusal: unknown;
    try {
      await s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: oldCallerAmount,
        idempotencyKey: "sn31-old",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeDefined();
    const message = String((refusal as { data?: unknown; message?: string })?.data ?? (refusal as Error)?.message ?? refusal);
    console.log("SN3-1 first refusal (OLD caller, switch BEFORE finalize):", message);
    // Refused at the amount gate — before any posting — so the old caller
    // never reached the currency assertion, and never settled either.
    expect(message).toMatch(/not what this financing company owes/i);
    expect(await settlementDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });

  test("AFTER finalization — the product lock REFUSES an org currency change once the sale has posted", async () => {
    const s = await seedDealership("post");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await finalize(s, applicationId);

    await expect(switchOrgCurrencyViaProduct(s, "USD")).rejects.toThrow(
      /currency cannot be changed after financial records exist/i
    );
    const settings = await s.t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()
    );
    expect(settings?.currency).toBe("JOD");
  });

  test("AFTER finalization — a raw settings edit (support migration / data repair) reaches the same dead end", async () => {
    const s = await seedDealership("post2");
    const { applicationId } = await approvedDealWithPinnedEconomics(s);
    await finalize(s, applicationId);
    const closed = await app(s, applicationId);
    const before = await settlementDelta(s, applicationId);

    // Not a product path: the only way currency changes after posting.
    await s.t.run(async (ctx) => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
      await ctx.db.patch(settings!._id, { currency: "USD", currencySymbol: "$" });
    });

    await expect(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: closed!.financedSaleNetReceivableMinor!,
        idempotencyKey: "sn31-post2",
      })
    ).rejects.toThrow(/currency/i);
    expect(await settlementDelta(s, applicationId)).toEqual(before);
    expect((await app(s, applicationId))?.disbursedAt).toBeUndefined();
  });
});
