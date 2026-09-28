import { TestConvex as ConvexTestInstance } from "convex-test";
import { ConvexError } from "convex/values";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { evaluateClosingReadiness } from "./utils/financedSaleRecognition";
import { handoverPaymentState, type HandoverPaymentLine } from "./utils/handoverCostPayment";

/**
 * SCRUM-443 — a dealer-borne handover cost reaches the ledger exactly once,
 * from the source of the cash that paid it: the employee custody, or a direct
 * dealership payment recorded with `CONFIRM_FINANCE_DISBURSEMENT`.
 *
 * Every test runs the real mutations against the real posting engine; none
 * stubs a hook. The direct payment's credit is the OUTBOUND account of its
 * method (`disbursementAccountKey`), never the inbound `cashAccountKey`.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  otherOrgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: ReturnType<TestConvex["withIdentity"]>;
  asSales: ReturnType<TestConvex["withIdentity"]>;
}

async function seedDeal(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Direct ${suffix}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Other ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_user_${suffix}`, email: `dp${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_emp_${suffix}`, email: `emp${suffix}@x.com`, name: "Emp" }));
  const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_sales_${suffix}`, email: `sales${suffix}@x.com`, name: "Sales" }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const salesRole = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "SALES",
      permissions: [PERMISSIONS.VIEW_FINANCE_APPLICATIONS, PERMISSIONS.CREATE_FINANCE_APPLICATION],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRole }));
  const { applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `DPVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "DP", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { applicationId };
  });
  const asUser = t.withIdentity({ subject: `dp_user_${suffix}` });
  const asSales = t.withIdentity({ subject: `dp_sales_${suffix}` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    openImmediately: true,
  });
  return { t, orgId, otherOrgId, userId, employeeId, applicationId, asUser, asSales };
}

async function dealerFee(
  seed: Seed,
  actualAmountMinor: number | undefined,
  extra: Partial<{
    paidBy: "DEALER" | "EMPLOYEE";
    custodyId: Id<"financeDealCustody">;
    deductedFromSettlement: boolean;
    feeType: "LICENSING" | "OTHER_CLOSING_EXPENSE";
    estimatedAmountMinor: number;
  }> = {}
) {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId, applicationId: seed.applicationId,
    feeType: extra.feeType ?? "LICENSING", paidBy: extra.paidBy ?? "DEALER", paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
    deductedFromSettlement: extra.deductedFromSettlement ?? false,
    actualAmountMinor, estimatedAmountMinor: extra.estimatedAmountMinor, custodyId: extra.custodyId,
  });
}

type Method = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

function payDirect(
  seed: Seed,
  feeId: Id<"financeDealFees">,
  extra: Partial<{ method: Method; paidAt: number; reference: string; idempotencyKey: string; as: Seed["asUser"] }> = {}
) {
  return (extra.as ?? seed.asUser).mutation(api.financeDealCosts.recordDirectFeePayment, {
    orgId: seed.orgId, feeId, method: extra.method ?? "BANK_TRANSFER",
    paidAt: extra.paidAt ?? Date.now() - DAY, reference: extra.reference,
    idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
  });
}

async function ledger(seed: Seed): Promise<Record<string, number>> {
  return await seed.t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === seed.orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    const totals: Record<string, number> = {};
    for (const entry of (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === seed.orgId)) {
      if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
      for (const l of lines) {
        const key = keyByAccount.get(l.accountId);
        if (key) totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

async function journalCount(seed: Seed): Promise<number> {
  return await seed.t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === seed.orgId).length);
}

async function directEvents(seed: Seed) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect()).filter(
      (e) => e.eventType === "HANDOVER_COST_PAID_DIRECT"
    )
  );
}

const expense = (l: Record<string, number>) => l[SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE] ?? 0;
const cash = (l: Record<string, number>) => l[SYSTEM_KEYS.CASH_ON_HAND] ?? 0;
const bank = (l: Record<string, number>) => l[SYSTEM_KEYS.BANK_ACCOUNT] ?? 0;

const lineOf = async (seed: Seed, feeId: Id<"financeDealFees">) => {
  const costs = await seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
  return costs.fees.find((f: { _id: Id<"financeDealFees"> }) => f._id === feeId);
};

const readiness = async (seed: Seed, settlesDirect = false) =>
  await seed.t.run(async (ctx) => {
    const app = (await ctx.db.get("financeApplications", seed.applicationId))!;
    const result = await evaluateClosingReadiness(ctx, app, { settlesDirect, currency: "JOD" });
    return result.readiness.checks.find((c) => c.key === "HANDOVER_COSTS_PAID")!;
  });

describe("the credit is the OUTBOUND account of the method the dealership paid with", () => {
  test.each([
    ["BANK_TRANSFER", "bank"],
    ["CHEQUE", "bank"],
    ["CARD", "bank"],
    ["CASH", "cash"],
  ] as const)("%s credits %s, debits the treatment's expense, once", async (method, account) => {
    const seed = await seedDeal(`m-${method}`);
    const feeId = await dealerFee(seed, jod(90));
    await payDirect(seed, feeId, { method });
    const l = await ledger(seed);
    expect(expense(l)).toBe(jod(90));
    if (account === "bank") {
      expect(bank(l)).toBe(-jod(90));
      expect(cash(l)).toBe(0);
    } else {
      expect(cash(l)).toBe(-jod(90));
      expect(bank(l)).toBe(0);
    }
    expect(await directEvents(seed)).toHaveLength(1);
    expect((await directEvents(seed))[0].status).toBe("POSTED");
  });
});

describe("idempotency and the one-payment rule", () => {
  test("the same key replays: one journal, and the same answer", async () => {
    const seed = await seedDeal("replay");
    const feeId = await dealerFee(seed, jod(50));
    const args = { method: "BANK_TRANSFER" as const, paidAt: Date.now() - DAY, reference: "TRX-1", idempotencyKey: "same-key" };
    const first = await payDirect(seed, feeId, args);
    const journals = await journalCount(seed);
    const second = await payDirect(seed, feeId, args);
    expect(second).toBe(first);
    expect(await journalCount(seed)).toBe(journals);
    expect(await directEvents(seed)).toHaveLength(1);
    expect(expense(await ledger(seed))).toBe(jod(50));
  });

  test("a different payload under the same key is refused, and nothing changes", async () => {
    const seed = await seedDeal("conflict");
    const feeId = await dealerFee(seed, jod(50));
    const paidAt = Date.now() - DAY;
    await payDirect(seed, feeId, { method: "BANK_TRANSFER", paidAt, idempotencyKey: "k" });
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId, { method: "CASH", paidAt, idempotencyKey: "k" })).rejects.toThrow();
    expect(await journalCount(seed)).toBe(journals);
    expect(cash(await ledger(seed))).toBe(0);
  });

  test("a second payment on a paid line, under a fresh key, is refused", async () => {
    const seed = await seedDeal("twice");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId)).rejects.toThrow(/already recorded/);
    expect(await journalCount(seed)).toBe(journals);
    expect(expense(await ledger(seed))).toBe(jod(50));
  });
});

describe("who and what may be paid this way", () => {
  test("a role with cost entry but no disbursement authority is refused, with no write", async () => {
    const seed = await seedDeal("sales");
    const feeId = await dealerFee(seed, jod(50));
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId, { as: seed.asSales })).rejects.toThrow();
    expect(await journalCount(seed)).toBe(journals);
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("UNPAID");
  });

  test("a fee that belongs to another organization is not found, and nothing posts", async () => {
    const seed = await seedDeal("tenant");
    const foreignFee = await seed.t.run((ctx) =>
      ctx.db.insert("financeDealFees", {
        orgId: seed.otherOrgId, applicationId: seed.applicationId, feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT",
        accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(10), currency: "JOD",
        includedInQuotation: false, deductedFromSettlement: false, refundable: false,
        source: "MANUAL", createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      } as never)
    );
    const journals = await journalCount(seed);
    await expect(payDirect(seed, foreignFee)).rejects.toThrow(/not found/i);
    expect(await journalCount(seed)).toBe(journals);
  });

  test("an EMPLOYEE-paid line is refused with the next step (custody), not paid directly", async () => {
    const seed = await seedDeal("employee");
    const feeId = await dealerFee(seed, jod(50), { paidBy: "EMPLOYEE" });
    await expect(payDirect(seed, feeId)).rejects.toThrow(/custody/);
    expect(await journalCount(seed)).toBe(0);
  });

  test("a custody-linked line is refused, and its custody posting is the only one", async () => {
    const seed = await seedDeal("custodylinked");
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700), method: "CASH",
    });
    const feeId = await dealerFee(seed, jod(50), { paidBy: "EMPLOYEE", custodyId });
    const before = await ledger(seed);
    await expect(payDirect(seed, feeId)).rejects.toThrow(/custody/);
    expect(await ledger(seed)).toEqual(before);
    expect(await directEvents(seed)).toHaveLength(0);
  });

  test("a zero actual and a missing actual are refused", async () => {
    const seed = await seedDeal("noactual");
    const zero = await dealerFee(seed, 0);
    const missing = await dealerFee(seed, undefined, { estimatedAmountMinor: jod(30) });
    await expect(payDirect(seed, zero)).rejects.toThrow(/more than zero/);
    await expect(payDirect(seed, missing)).rejects.toThrow(/actually came to/);
    expect(await journalCount(seed)).toBe(0);
  });

  test("a date in the future is refused", async () => {
    const seed = await seedDeal("future");
    const feeId = await dealerFee(seed, jod(50));
    await expect(payDirect(seed, feeId, { paidAt: Date.now() + 3 * DAY })).rejects.toThrow();
    expect(await journalCount(seed)).toBe(0);
  });
});

describe("corrections: an amount edit or a void reverses the payment and never re-posts it", () => {
  test("void after payment reverses exactly once; a second void reverses nothing more", async () => {
    const seed = await seedDeal("void");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId, { method: "CASH" });
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
    const afterFirst = await ledger(seed);
    expect(expense(afterFirst)).toBe(0);
    expect(cash(afterFirst)).toBe(0);
    const journals = await journalCount(seed);
    // Voiding a void is a no-op: it must not reverse the payment a second time.
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "again" });
    expect(await journalCount(seed)).toBe(journals);
    expect(await ledger(seed)).toEqual(afterFirst);
    expect((await directEvents(seed))[0].status).toBe("REVERSED");
  });

  test("an amount edit reverses the payment, leaves the line unpaid, and posts nothing by itself", async () => {
    const seed = await seedDeal("edit");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("PAID_DIRECT");
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    const l = await ledger(seed);
    expect(expense(l)).toBe(0);
    expect(bank(l)).toBe(0);
    const line = await lineOf(seed, feeId);
    expect(line?.handoverPayment).toBe("UNPAID");
    expect(line?.directPayment).toBeUndefined();
    expect((await readiness(seed)).status).toBe("BLOCKED");

    // Paying the corrected amount is a fresh, later version: it is not blocked by the reversed one.
    await payDirect(seed, feeId);
    const paid = await ledger(seed);
    expect(expense(paid)).toBe(jod(65));
    expect(bank(paid)).toBe(-jod(65));
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("PAID_DIRECT");
  });

  test("an edit that leaves the amount unchanged does not reverse the payment", async () => {
    const seed = await seedDeal("editsame");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(50), expectedCurrency: "JOD", receiptReference: "R-1",
    });
    expect(expense(await ledger(seed))).toBe(jod(50));
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("PAID_DIRECT");
  });

  test("cost entry alone cannot un-happen a payment it could not have made", async () => {
    const seed = await seedDeal("salesvoid");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await expect(
      seed.asSales.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "x" })
    ).rejects.toThrow();
    await expect(
      seed.asSales.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId, actualAmountMinor: jod(10), expectedCurrency: "JOD",
      })
    ).rejects.toThrow();
    expect(expense(await ledger(seed))).toBe(jod(50));
  });

  test("cancelling the application never reverses a direct payment: the money left the dealership", async () => {
    const seed = await seedDeal("cancel");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    const before = await ledger(seed);
    const journals = await journalCount(seed);
    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "cancel-1",
    });
    expect((await seed.t.run((ctx) => ctx.db.get("financeApplications", seed.applicationId)))?.status).toBe("CANCELLED");
    expect(await ledger(seed)).toEqual(before);
    expect(await journalCount(seed)).toBe(journals);
    expect((await directEvents(seed))[0].status).toBe("POSTED");
  });
});

describe("HANDOVER_COSTS_PAID blocks the deal on every route", () => {
  const routes: Array<[string, boolean, boolean]> = [
    // [route, has a finance company (plan route), settles direct]
    ["a plan route (configured finance company)", true, false],
    ["a route with no finance company", false, false],
    ["a route where the finance company settles directly", true, true],
  ];

  async function withCompany(seed: Seed) {
    const companyId = await seed.asUser.mutation(api.finance.createCompany, {
      orgId: seed.orgId, name: "JAF", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0,
      defaultLtvPercent: 100, isActive: true,
    });
    await seed.t.run((ctx) => ctx.db.patch("financeApplications", seed.applicationId, { companyId }));
  }

  test.each(routes)("an unpaid line blocks %s", async (_name, hasCompany, settlesDirect) => {
    const seed = await seedDeal(`route-${hasCompany}-${settlesDirect}`);
    if (hasCompany) await withCompany(seed);
    const feeId = await dealerFee(seed, jod(50));
    const check = await readiness(seed, settlesDirect);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_UNPAID");
    expect(check.reason?.params).toEqual({ count: 1 });
    expect(check.feeIds).toEqual([feeId]);
    // Paid directly, the same deal passes the check on the same route.
    await payDirect(seed, feeId);
    const after = await readiness(seed, settlesDirect);
    expect(after.status).toBe("READY");
    expect(after.feeIds).toBeUndefined();
  });

  test("a handover line with no actual blocks an off-plan route, with its own code", async () => {
    const seed = await seedDeal("noactual-offplan");
    const feeId = await dealerFee(seed, undefined, { estimatedAmountMinor: jod(30) });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_NO_ACTUAL");
    expect(check.feeIds).toEqual([feeId]);
  });

  test("a custody-posted line passes; a zero-actual line is exempt", async () => {
    const seed = await seedDeal("custodypass");
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700), method: "CASH",
    });
    await dealerFee(seed, jod(50), { paidBy: "EMPLOYEE", custodyId });
    await dealerFee(seed, 0);
    const check = await readiness(seed);
    expect(check.status).toBe("READY");
  });

  test("a line the finance company settles, or a non-handover line, is outside the invariant", async () => {
    const seed = await seedDeal("outside");
    await dealerFee(seed, jod(40), { deductedFromSettlement: true });
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("a deal with no costs at all passes this check (COSTS_CLOSABLE owns 'none recorded')", async () => {
    const seed = await seedDeal("nocosts");
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("finalizeDeal refuses with this reason, and finalizes nothing", async () => {
    const seed = await seedDeal("finalize");
    await dealerFee(seed, jod(50));
    await registerHandover(seed.asUser, api, seed.orgId, seed.applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId, applicationId: seed.applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    let refusal: unknown;
    try {
      await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "fin-1",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<{ code: string }>).data.code).toBe("HANDOVER_COSTS_UNPAID");
    expect((await seed.t.run((ctx) => ctx.db.get("financeApplications", seed.applicationId)))?.status).toBe("APPROVED");
  });

  test("getClosingReadiness serves the same blocking line ids to the deal screen", async () => {
    const seed = await seedDeal("served");
    const feeId = await dealerFee(seed, jod(50));
    const served = await seed.asUser.query(api.applications.getClosingReadiness, {
      orgId: seed.orgId, applicationId: seed.applicationId,
    });
    const check = served.checks.find((c) => c.key === "HANDOVER_COSTS_PAID");
    expect(check?.status).toBe("BLOCKED");
    expect(check?.feeIds).toEqual([feeId]);
    expect((await seed.asUser.query(api.financeDealCosts.listDealCosts, {
      orgId: seed.orgId, applicationId: seed.applicationId,
    })).handoverCostsBlockingFeeIds).toEqual([feeId]);
  });
});

describe("the screen's projection agrees with the server's refusal", () => {
  test("directPaymentEligible is true exactly where the mutation would accept", async () => {
    const seed = await seedDeal("eligible");
    const ok = await dealerFee(seed, jod(50));
    const employee = await dealerFee(seed, jod(50), { paidBy: "EMPLOYEE" });
    const zero = await dealerFee(seed, 0);
    expect((await lineOf(seed, ok))?.directPaymentEligible).toBe(true);
    expect((await lineOf(seed, employee))?.directPaymentEligible).toBe(false);
    expect((await lineOf(seed, zero))?.directPaymentEligible).toBe(false);
    await payDirect(seed, ok);
    expect((await lineOf(seed, ok))?.directPaymentEligible).toBe(false);
  });
});

describe("the shared verdict never trusts a payment that no longer matches the cost", () => {
  const base: HandoverPaymentLine = {
    voidedAt: undefined, feeType: "LICENSING", paidBy: "DEALER", deductedFromSettlement: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(50),
    custodyId: undefined, custodyPosted: undefined, directPayment: undefined,
  };
  const payment = (amountMinor: number) => ({
    version: 1, amountMinor, method: "CASH" as const, paidAt: 1, recordedBy: "u" as Id<"users">, recordedAt: 1,
  });

  test("a direct payment of a different amount than the actual is UNPAID, not paid", () => {
    expect(handoverPaymentState({ ...base, directPayment: payment(jod(50)) })).toBe("PAID_DIRECT");
    expect(handoverPaymentState({ ...base, directPayment: payment(jod(40)) })).toBe("UNPAID");
  });

  test("a line carrying both a custody posting and a direct payment is a CONFLICT that blocks", () => {
    const both = {
      ...base, directPayment: payment(jod(50)),
      custodyPosted: { custodyId: "c" as Id<"financeDealCustody">, amountMinor: jod(50) },
    } as HandoverPaymentLine;
    expect(handoverPaymentState(both)).toBe("CONFLICT");
  });

  test("a corrupt actual (NaN, fraction, negative) is UNPAID, never exempt or paid", () => {
    for (const bad of [Number.NaN, 1.5, -5]) {
      expect(handoverPaymentState({ ...base, actualAmountMinor: bad })).toBe("UNPAID");
    }
  });
});
