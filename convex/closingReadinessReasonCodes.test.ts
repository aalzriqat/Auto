import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { evaluateClosingReadiness, resolveFinancedSalePlan } from "./utils/financedSaleRecognition";
import { WITHHELD_READINESS_REASON_FALLBACK } from "../lib/closingReadinessReasonCodes";

/**
 * SCRUM-414: the closing-readiness evaluator names every unmet check with a
 * CODE and its params (translated by the deal screen), and keeps its English
 * sentence as the diagnostic. One case per family, asked of the evaluator
 * itself — the same function `getClosingReadiness` and `finalizeDeal` run.
 */
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number) => Math.round(major * 1000);

type AppPatch = Partial<Doc<"financeApplications">>;

async function seed(appPatch: AppPatch = {}) {
  const t = convexTestWithComponents(schema, MODULES);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Codes Dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "codes_user", email: "codes@x.com" });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "CODESVIN", make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Codes", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId, name: "Codes Bank", isActive: true, profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0,
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, companyId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      ...appPatch,
    });
    return { orgId, userId, applicationId };
  });
  return { t, ...ids };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function fee(s: Seeded, patch: Partial<Doc<"financeDealFees">> = {}): Promise<Id<"financeDealFees">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("financeDealFees", {
      orgId: s.orgId, applicationId: s.applicationId, feeType: "LICENSING", currency: "JOD",
      paidBy: "DEALER", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      includedInQuotation: false, deductedFromSettlement: false, refundable: false, source: "MANUAL",
      createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      ...patch,
    })
  );
}

async function custody(s: Seeded, patch: Partial<Doc<"financeDealCustody">> = {}): Promise<Id<"financeDealCustody">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("financeDealCustody", {
      orgId: s.orgId, applicationId: s.applicationId, userId: s.userId, currency: "JOD",
      issuedMinor: jod(100), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
      createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      ...patch,
    })
  );
}

async function checks(s: Seeded) {
  const readiness = await s.t.run(async (ctx) => {
    const app = (await ctx.db.get(s.applicationId))!;
    return (await evaluateClosingReadiness(ctx, app, { settlesDirect: false, currency: "JOD" })).readiness;
  });
  return new Map(readiness.checks.map((check) => [check.key, check]));
}

describe("SCRUM-414 — every unmet readiness check carries a code, its params and the English diagnostic", () => {
  test("remittance: approval missing vs remittance unknown; first payment; legal invoice missing", async () => {
    const noApproval = await checks(await seed());
    expect(noApproval.get("REMITTANCE_KNOWN")).toMatchObject({
      status: "UNAVAILABLE", reason: { code: "REMITTANCE_APPROVAL_MISSING", message: expect.stringMatching(/approved purchase amount/) },
    });
    expect(noApproval.get("LEGAL_INVOICE_RECORDED")).toMatchObject({
      status: "BLOCKED", reason: { code: "LEGAL_INVOICE_MISSING", message: expect.stringMatching(/no legal invoice/) },
    });

    const approved = await checks(
      await seed({ approvedDealerPurchaseAmountMinor: jod(10_000), submittedQuotationMinor: jod(10_000) })
    );
    expect(approved.get("REMITTANCE_KNOWN")).toMatchObject({ status: "BLOCKED", reason: { code: "REMITTANCE_UNKNOWN" } });
    expect(approved.get("FIRST_PAYMENT_RECORDED")).toMatchObject({ status: "BLOCKED", reason: { code: "FIRST_PAYMENT_MISSING" } });
  });

  test("legal invoice: an unusable amount and a wrong recipient are distinct codes", async () => {
    const unusable = await checks(await seed({ legalInvoiceAmountMinor: -1, legalInvoiceIssuedTo: "FINANCE_COMPANY" }));
    expect(unusable.get("LEGAL_INVOICE_RECORDED")).toMatchObject({ reason: { code: "LEGAL_INVOICE_UNUSABLE" } });
    const wrong = await checks(await seed({ legalInvoiceAmountMinor: jod(10_000), legalInvoiceIssuedTo: "CUSTOMER" }));
    expect(wrong.get("LEGAL_INVOICE_RECORDED")).toMatchObject({
      status: "BLOCKED", reason: { code: "LEGAL_INVOICE_WRONG_RECIPIENT", message: expect.stringMatching(/issued to customer/) },
    });
  });

  test("configured fees: a configured position with no actual is CONFIGURED_FEES_MISSING {count}", async () => {
    const s = await seed({
      companyRuleSnapshot: {
        ruleVersion: 1, companyName: "Codes Bank",
        feeTemplates: [{
          feeType: "LICENSING", estimatedAmountMinor: jod(90), paidBy: "DEALER", paidTo: "GOVERNMENT",
          includedInQuotation: false, deductedFromSettlement: false, refundable: false, accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        }],
      },
    });
    expect((await checks(s)).get("CONFIGURED_FEES_RECORDED")).toMatchObject({
      status: "BLOCKED", reason: { code: "CONFIGURED_FEES_MISSING", params: { count: 1 }, message: expect.stringMatching(/1 fee\(s\)/) },
    });
  });

  test("costs: none, foreign currency {count,currency}, awaiting actual {count}, unmapped treatment {feeLabel,treatment}", async () => {
    expect((await checks(await seed())).get("COSTS_CLOSABLE")).toMatchObject({ status: "BLOCKED", reason: { code: "COSTS_NONE" } });

    const foreign = await seed();
    await fee(foreign, { currency: "USD", actualAmountMinor: 100 });
    expect((await checks(foreign)).get("COSTS_CLOSABLE")).toMatchObject({
      reason: { code: "COSTS_FOREIGN_CURRENCY", params: { count: 1, currency: "JOD" }, message: expect.stringMatching(/not in JOD/) },
    });

    const awaiting = await seed();
    await fee(awaiting);
    expect((await checks(awaiting)).get("COSTS_CLOSABLE")).toMatchObject({
      reason: { code: "COSTS_AWAITING_ACTUAL", params: { count: 1 } },
    });

    const unmapped = await seed();
    await fee(unmapped, {
      description: "Refundable plate deposit", accountingTreatment: "REFUNDABLE_DEPOSIT", deductedFromSettlement: true,
      actualAmountMinor: jod(120), reconciledAt: Date.now(), reconciledBy: unmapped.userId,
    });
    expect((await checks(unmapped)).get("COSTS_CLOSABLE")).toMatchObject({
      reason: {
        code: "COSTS_TREATMENT_UNMAPPED",
        params: { feeLabel: "Refundable plate deposit", treatment: "REFUNDABLE_DEPOSIT" },
        message: expect.stringMatching(/no account to post to/),
      },
    });
  });

  test("custody: open record, ledger proof refusal, and a cross-currency charge {lineCurrency,custodyCurrency}", async () => {
    const open = await seed();
    await custody(open);
    const openChecks = await checks(open);
    expect(openChecks.get("CUSTODY_SETTLED")).toMatchObject({ status: "BLOCKED", reason: { code: "CUSTODY_OPEN" } });
    // A record the ledger proof refuses is one coarse code; its detail stays the diagnostic.
    expect(openChecks.get("CUSTODY_ON_LEDGER")).toMatchObject({
      status: "BLOCKED", reason: { code: "CUSTODY_NOT_ON_LEDGER", message: expect.any(String) },
    });
    expect(openChecks.get("CUSTODY_ON_LEDGER")?.reason).not.toHaveProperty("params");

    const mixed = await seed();
    const custodyId = await custody(mixed, { status: "RECONCILED" });
    await fee(mixed, { currency: "USD", paidBy: "EMPLOYEE", custodyId, actualAmountMinor: 100 });
    expect((await checks(mixed)).get("CUSTODY_SETTLED")).toMatchObject({
      status: "BLOCKED",
      reason: { code: "CUSTODY_CURRENCY_MISMATCH", params: { lineCurrency: "USD", custodyCurrency: "JOD" }, message: expect.stringMatching(/recorded in USD/) },
    });
  });

  test("rows past the custody bound: every row check is UNAVAILABLE with DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS {max}", async () => {
    const s = await seed();
    for (let i = 0; i < 101; i++) await custody(s);
    const byKey = await checks(s);
    for (const key of ["CONFIGURED_FEES_RECORDED", "CUSTODY_ON_LEDGER", "CUSTODY_SETTLED", "COSTS_CLOSABLE"] as const) {
      expect(byKey.get(key)).toMatchObject({
        status: "UNAVAILABLE", reason: { code: "DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS", params: { max: 100 } },
      });
    }
  });

  test("a check that is met or not applicable carries no code", async () => {
    const byKey = await checks(await seed({ expectedDealerRemittanceMinor: jod(10_000) }));
    expect(byKey.get("REMITTANCE_KNOWN")).toEqual({ key: "REMITTANCE_KNOWN", status: "READY", reason: null });
  });
});

describe("SCRUM-414 — the finalize door's refusal carries the same code", () => {
  test("resolveFinancedSalePlan (what finalizeDeal runs) throws the first unmet check's code and params, English kept as the message", async () => {
    const s = await seed({ expectedDealerRemittanceMinor: jod(10_000) });
    await fee(s, { currency: "USD", actualAmountMinor: 100 });
    const error = await s.t.run(async (ctx) => {
      const app = (await ctx.db.get(s.applicationId))!;
      try {
        await resolveFinancedSalePlan(ctx, app, { settlesDirect: false, currency: "JOD", mayReadMoney: true });
        return null;
      } catch (caught) {
        return caught instanceof ConvexError ? { data: caught.data as unknown, message: caught.message } : { data: "not a ConvexError", message: "" };
      }
    });
    expect(error?.data).toMatchObject({
      code: "COSTS_FOREIGN_CURRENCY",
      params: { count: 1, currency: "JOD" },
      message: expect.stringMatching(/not in JOD/),
    });
    expect(error?.message).toMatch(/cost line\(s\) on this deal are not in JOD/);
  });
});

describe("SCRUM-414 R1 — below the finance tier the resolver throws only the check's WITHHELD code", () => {
  test("mayReadMoney: false → WITHHELD_COSTS_CLOSABLE, no params, the fixed fallback sentence", async () => {
    const s = await seed({ expectedDealerRemittanceMinor: jod(10_000) });
    await fee(s, { currency: "USD", actualAmountMinor: 100 });
    const data = await s.t.run(async (ctx) => {
      const app = (await ctx.db.get(s.applicationId))!;
      try {
        await resolveFinancedSalePlan(ctx, app, { settlesDirect: false, currency: "JOD", mayReadMoney: false });
        return null;
      } catch (caught) {
        return caught instanceof ConvexError ? (caught.data as unknown) : "not a ConvexError";
      }
    });
    expect(data).toEqual({ code: "WITHHELD_COSTS_CLOSABLE", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(JSON.stringify(data)).not.toMatch(/JOD|USD|count/);
  });
});
