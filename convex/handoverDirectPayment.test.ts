import { TestConvex as ConvexTestInstance } from "convex-test";
import { ConvexError } from "convex/values";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { drainEntries } from "./accountingOutbox";
import { MAX_CUSTODY_READ_BATCH } from "./utils/custodySourceLedger";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { evaluateClosingReadiness, handoverDirectLedgerRefusal } from "./utils/financedSaleRecognition";
import {
  MAX_DIRECT_PAID_LINES,
  MAX_DIRECT_PAYMENT_VERSIONS,
  MAX_HANDOVER_DIRECT_LEDGER_PROOFS,
} from "./utils/custodySourceLedger";
import {
  handoverDirectPostKey,
  handoverDirectReversalKey,
  handoverPaymentState,
  type HandoverPaymentLine,
} from "./utils/handoverCostPayment";

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

/**
 * Records a direct payment the way the screen does: the amount SENT is the
 * amount the approver saw — the line's actual as it stands when this is called,
 * unless the test says the form was rendered at another figure (`expected`).
 */
async function payDirect(
  seed: Seed,
  feeId: Id<"financeDealFees">,
  extra: Partial<{ method: Method; paidAt: number; reference: string; idempotencyKey: string; as: Seed["asUser"]; expected: number }> = {}
) {
  const expectedAmountMinor =
    extra.expected ?? (await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.actualAmountMinor ?? 0;
  return await (extra.as ?? seed.asUser).mutation(api.financeDealCosts.recordDirectFeePayment, {
    orgId: seed.orgId, feeId, method: extra.method ?? "BANK_TRANSFER",
    paidAt: extra.paidAt ?? Date.now() - DAY, reference: extra.reference,
    expectedAmountMinor,
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

// ---------------------------------------------------------------------------
// The closing check proves a direct payment on the LEDGER, not on the row.

const closePeriod = (seed: Seed) =>
  seed.t.run(async (ctx) => {
    for (const p of (await ctx.db.query("accountingPeriods").collect()).filter((x) => x.orgId === seed.orgId)) {
      await ctx.db.patch(p._id, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId });
    }
  });
const openPeriod = (seed: Seed) =>
  seed.t.run(async (ctx) => {
    for (const p of (await ctx.db.query("accountingPeriods").collect()).filter((x) => x.orgId === seed.orgId)) {
      await ctx.db.patch(p._id, { status: "OPEN", closedAt: undefined, closedBy: undefined });
    }
  });

async function pump(t: TestConvex) {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
      (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
    ).length;
    if (queued === 0) break;
  }
}

/** ONE real outbox attempt per due row, as the cron would drive it (mirrors dealCustodyAccounting's `drainOnce`). */
async function drainOnce(seed: Seed) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const pending = (ctx: import("./_generated/server").MutationCtx) =>
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", seed.orgId).eq("status", "PENDING")).take(50);
    await seed.t.run(async (ctx) => {
      for (const row of await pending(ctx)) if (row.dispatchState === undefined) await ctx.db.patch(row._id, { nextActionAt: undefined });
      return await drainEntries(ctx, await pending(ctx));
    });
    await pump(seed.t);
    const claimed = await seed.t.run(async (ctx) => (await pending(ctx)).filter((r) => r.dispatchState === "DISPATCHED").map((r) => r._id));
    for (const rowId of claimed) await seed.t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });
    await pump(seed.t);
  } finally {
    vi.useRealTimers();
  }
}

describe("HANDOVER_COSTS_PAID proves each direct payment on the ledger (SCRUM-443 gap 1)", () => {
  test("no open period: the payment queues, the check is BLOCKED and finalizeDeal refuses; once posted it is READY", async () => {
    const seed = await seedDeal("ledger-queued");
    await closePeriod(seed);
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    // The row says paid; the books do not have it.
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("PAID_DIRECT");
    expect(await directEvents(seed)).toHaveLength(0);
    expect(expense(await ledger(seed))).toBe(0);
    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_NOT_ON_LEDGER");
    expect(blocked.reason?.params).toEqual({ count: 1 });
    expect(blocked.feeIds).toEqual([feeId]);

    await registerHandover(seed.asUser, api, seed.orgId, seed.applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId, applicationId: seed.applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    let refusal: unknown;
    try {
      await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "fin-q" });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as ConvexError<{ code: string }>).data.code).toBe("HANDOVER_DIRECT_NOT_ON_LEDGER");

    await openPeriod(seed);
    await drainOnce(seed);
    expect(await directEvents(seed)).toHaveLength(1);
    expect(expense(await ledger(seed))).toBe(jod(50));
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("amount edit then re-record: BLOCKED while the v1 reversal has not posted, READY once v2 is on the books", async () => {
    const seed = await seedDeal("ledger-rerecord");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    expect((await readiness(seed)).status).toBe("READY");
    // The period closes; the edit's reversal of v1 defers instead of posting.
    await closePeriod(seed);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    expect((await directEvents(seed))[0].status).toBe("POSTED");
    expect((await readiness(seed)).status).toBe("BLOCKED");
    // Re-recording is refused while v1 is still on the books (no double charge).
    await expect(payDirect(seed, feeId)).rejects.toThrow();
    expect(expense(await ledger(seed))).toBe(jod(50));

    await openPeriod(seed);
    await drainOnce(seed);
    expect((await directEvents(seed))[0].status).toBe("REVERSED");
    expect(expense(await ledger(seed))).toBe(0);
    await payDirect(seed, feeId);
    expect(expense(await ledger(seed))).toBe(jod(65));
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("defence in depth: a live v2 with an earlier version still POSTED is BLOCKED, never READY", async () => {
    const seed = await seedDeal("ledger-earlier");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    await payDirect(seed, feeId);
    expect((await readiness(seed)).status).toBe("READY");
    // A raw edit puts v1 back on the books beside v2 (the mutation itself refuses to produce this).
    const v1 = (await directEvents(seed)).find((e) => e.idempotencyKey === handoverDirectPostKey(feeId, 1))!;
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { status: "POSTED" }));
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    // The same condition as a voided line's pending reversal: money is still on
    // the books that the row says was taken back, and the next step is the same.
    expect(check.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect(check.feeIds).toEqual([feeId]);
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { status: "REVERSED" }));
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("a ledger page that cannot be read completely is UNAVAILABLE, not READY", async () => {
    const seed = await seedDeal("ledger-unreadable");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    expect((await readiness(seed)).status).toBe("READY");
    const posted = (await directEvents(seed))[0];
    // A full page of rows under the one key is more than a posting can have: unverifiable.
    await seed.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = posted;
      void _id; void _creationTime;
      for (let i = 0; i < MAX_CUSTODY_READ_BATCH; i += 1) await ctx.db.insert("accountingEvents", { ...copy });
    });
    const check = await readiness(seed);
    expect(check.status).toBe("UNAVAILABLE");
    expect(check.reason?.code).toBe("HANDOVER_DIRECT_LEDGER_UNVERIFIABLE");
  });

  test("custody-paid and zero-actual lines need no direct-payment proof", async () => {
    const seed = await seedDeal("ledger-custody");
    await dealerFee(seed, 0);
    expect((await readiness(seed)).status).toBe("READY");
  });
});

// ---------------------------------------------------------------------------
// SCRUM-443 fix round 1 (FIX-1): a payment reversed on its line but still POSTED
// is invisible to a gate that walks live lines only.

describe("HANDOVER_COSTS_PAID: a reversed payment still POSTED behind a closed period blocks the deal", () => {
  async function voidIt(seed: Seed, feeId: Id<"financeDealFees">) {
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
  }
  async function zeroIt(seed: Seed, feeId: Id<"financeDealFees">) {
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: 0, expectedCurrency: "JOD",
    });
  }

  test("void after payment, period closed: BLOCKED with the reversal-pending code, the voided line named; open + drain -> READY", async () => {
    const seed = await seedDeal("rev-void");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    expect((await readiness(seed)).status).toBe("READY");
    await closePeriod(seed);
    await voidIt(seed, feeId);
    // The reversal deferred: v1 is STILL on the books while the row says nothing is paid.
    expect((await directEvents(seed))[0].status).toBe("POSTED");
    expect(expense(await ledger(seed))).toBe(jod(50));
    expect(await lineOf(seed, feeId)).toBeUndefined();

    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect(blocked.reason?.params).toEqual({ count: 1 });
    expect(blocked.feeIds).toEqual([feeId]);
    // R6: the reason names the next step.
    expect(blocked.reason?.message).toMatch(/open the accounting period/i);

    await openPeriod(seed);
    await drainOnce(seed);
    expect((await directEvents(seed))[0].status).toBe("REVERSED");
    expect(expense(await ledger(seed))).toBe(0);
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("amount edited to zero after payment, period closed: BLOCKED; open + drain -> READY", async () => {
    const seed = await seedDeal("rev-zero");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await closePeriod(seed);
    await zeroIt(seed, feeId);
    expect((await directEvents(seed))[0].status).toBe("POSTED");
    expect((await lineOf(seed, feeId))?.handoverPayment).toBe("ZERO_ACTUAL");

    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect(blocked.feeIds).toEqual([feeId]);

    await openPeriod(seed);
    await drainOnce(seed);
    expect(expense(await ledger(seed))).toBe(0);
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("finalizeDeal refuses with the reversal-pending code, and finalizes nothing", async () => {
    const seed = await seedDeal("rev-finalize");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await closePeriod(seed);
    await voidIt(seed, feeId);
    await registerHandover(seed.asUser, api, seed.orgId, seed.applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId, applicationId: seed.applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    let refusal: unknown;
    try {
      await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "fin-rev" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<{ code: string }>).data.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect((await seed.t.run((ctx) => ctx.db.get("financeApplications", seed.applicationId)))?.status).toBe("APPROVED");
  });

  test("control: void / zero-edit with the period OPEN reverses at once, so the deal is READY immediately", async () => {
    const voided = await seedDeal("rev-ctl-void");
    const voidedFee = await dealerFee(voided, jod(50));
    await payDirect(voided, voidedFee);
    await voidIt(voided, voidedFee);
    expect((await directEvents(voided))[0].status).toBe("REVERSED");
    expect((await readiness(voided)).status).toBe("READY");

    const zeroed = await seedDeal("rev-ctl-zero");
    const zeroedFee = await dealerFee(zeroed, jod(50));
    await payDirect(zeroed, zeroedFee);
    await zeroIt(zeroed, zeroedFee);
    expect((await directEvents(zeroed))[0].status).toBe("REVERSED");
    expect((await readiness(zeroed)).status).toBe("READY");
  });

  test("an edit-then-void: the replaced payment's pending reversal is found on a line that is now voided", async () => {
    const seed = await seedDeal("rev-edit-void");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await closePeriod(seed);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    await voidIt(seed, feeId);
    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    await openPeriod(seed);
    await drainOnce(seed);
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("a live queued payment beside a voided line's pending reversal: both named", async () => {
    const seed = await seedDeal("rev-two");
    const voidedFee = await dealerFee(seed, jod(50));
    await payDirect(seed, voidedFee);
    await closePeriod(seed);
    await voidIt(seed, voidedFee);
    const liveFee = await dealerFee(seed, jod(20));
    await payDirect(seed, liveFee);
    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect([...(blocked.feeIds ?? [])].sort()).toEqual([voidedFee, liveFee].sort());
  });

  test("over the cap on lines that ever carried a payment: UNAVAILABLE, never READY", async () => {
    const seed = await seedDeal("rev-cap");
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("financeDealFees", {
          orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT",
          accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(1), currency: "JOD",
          includedInQuotation: false, deductedFromSettlement: false, refundable: false,
          source: "MANUAL", createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
          voidedAt: Date.now(), directPaymentVersion: 1,
        } as never);
      }
    });
    const check = await readiness(seed);
    expect(check.status).toBe("UNAVAILABLE");
    expect(check.reason?.code).toBe("HANDOVER_DIRECT_LEDGER_UNVERIFIABLE");
  });

  test("over the proof's document budget: a named ConvexError (so UNAVAILABLE), never a prefix judged READY", async () => {
    const seed = await seedDeal("rev-budget");
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await closePeriod(seed);
    await voidIt(seed, feeId);
    const outcome = await seed.t.run(async (ctx) => {
      const app = (await ctx.db.get("financeApplications", seed.applicationId))!;
      const fees = await ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).take(10);
      try {
        await handoverDirectLedgerRefusal(ctx, app.orgId, app._id, fees, 1);
        return "no refusal";
      } catch (error) {
        return error instanceof ConvexError ? "ConvexError" : `other: ${String(error)}`;
      }
    });
    expect(outcome).toBe("ConvexError");
  });
});

// ---------------------------------------------------------------------------
// SCRUM-443 fix round 1 (FIX-2): the payment posts the amount the approver saw.

describe("recordDirectFeePayment pays the amount the approver saw, not the amount at submit time", () => {
  test("a cost edited between render and submit is refused with the new figure, and nothing is posted", async () => {
    const seed = await seedDeal("exp-edited");
    const feeId = await dealerFee(seed, jod(50));
    const rendered = jod(50);
    // A concurrent edit lands after the form rendered and before it was submitted.
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId, { expected: rendered })).rejects.toThrow(/changed to 65.*record the payment again/s);
    expect(await journalCount(seed)).toBe(journals);
    expect(await directEvents(seed)).toHaveLength(0);
    const row = await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId));
    expect(row?.directPayment).toBeUndefined();
    expect(row?.directPaymentVersion).toBeUndefined();

    // Reviewed and recorded again at the figure now on screen: posts once, at 65.
    await payDirect(seed, feeId, { expected: jod(65) });
    expect(expense(await ledger(seed))).toBe(jod(65));
    expect(await directEvents(seed)).toHaveLength(1);
  });

  test("the same key and the same expected amount replays: one journal, one posting", async () => {
    const seed = await seedDeal("exp-replay");
    const feeId = await dealerFee(seed, jod(50));
    const args = { method: "BANK_TRANSFER" as const, paidAt: Date.now() - DAY, idempotencyKey: "exp-key", expected: jod(50) };
    const first = await payDirect(seed, feeId, args);
    const journals = await journalCount(seed);
    expect(await payDirect(seed, feeId, args)).toBe(first);
    expect(await journalCount(seed)).toBe(journals);
    expect(await directEvents(seed)).toHaveLength(1);
  });

  test("the same key for a DIFFERENT expected amount is a different intent, refused", async () => {
    const seed = await seedDeal("exp-conflict");
    const feeId = await dealerFee(seed, jod(50));
    const paidAt = Date.now() - DAY;
    await payDirect(seed, feeId, { paidAt, idempotencyKey: "exp-k", expected: jod(50) });
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId, { paidAt, idempotencyKey: "exp-k", expected: jod(51) })).rejects.toThrow();
    expect(await journalCount(seed)).toBe(journals);
  });

  test("an expected amount that is not a whole number of minor units is refused before anything is read", async () => {
    const seed = await seedDeal("exp-bad");
    const feeId = await dealerFee(seed, jod(50));
    for (const bad of [1.5, -1, Number.NaN]) {
      await expect(payDirect(seed, feeId, { expected: bad })).rejects.toThrow(/whole number/);
    }
    expect(await journalCount(seed)).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-443 fix round 2.

describe("R2-2: a reversal is dated when the payment is taken back, so THAT period is the one to open", () => {
  test("paid in a past period; void with the current period closed; opening ONLY the current period is enough", async () => {
    const seed = await seedDeal("r22");
    const year = new Date().getUTCFullYear();
    // The seeded period becomes the PAST one; the current year gets its own.
    await seed.t.run(async (ctx) => {
      for (const period of (await ctx.db.query("accountingPeriods").collect()).filter((x) => x.orgId === seed.orgId)) {
        await ctx.db.patch(period._id, { endDate: Date.UTC(year - 1, 11, 31, 23, 59, 59, 999) });
      }
    });
    await seed.asUser.mutation(api.accountingPeriods.create, {
      orgId: seed.orgId, fiscalYear: year, periodNumber: 2,
      startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true,
    });
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId, { paidAt: Date.UTC(year - 1, 5, 15) });
    expect((await directEvents(seed))[0].status).toBe("POSTED");
    await closePeriod(seed); // both
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
    const blocked = await readiness(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
    expect(blocked.reason?.message).toMatch(/taken back/i);
    expect(blocked.reason?.message).toMatch(/not the payment date/i);

    // Open ONLY the period covering today; the payment's own period stays closed.
    await seed.t.run(async (ctx) => {
      for (const period of (await ctx.db.query("accountingPeriods").collect()).filter((x) => x.orgId === seed.orgId)) {
        if (period.startDate === Date.UTC(year, 0, 1)) {
          await ctx.db.patch(period._id, { status: "OPEN", closedAt: undefined, closedBy: undefined });
        }
      }
    });
    await drainOnce(seed);
    expect((await directEvents(seed))[0].status).toBe("REVERSED");
    expect((await readiness(seed)).status).toBe("READY");
  });
});

describe("R2-3: the admission envelope guarantees the closing proof always fits", () => {
  const rawLine = (seed: Seed, extra: Record<string, unknown>) => ({
    orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", currency: "JOD",
    includedInQuotation: false, deductedFromSettlement: false, refundable: false,
    source: "MANUAL", createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
    ...extra,
  });
  const seedEverPaid = (seed: Seed, count: number) =>
    seed.t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("financeDealFees", rawLine(seed, { actualAmountMinor: jod(1), voidedAt: Date.now(), directPaymentVersion: 1 }) as never);
      }
    });

  test("the derived budget is the arithmetic in its comment", () => {
    expect(MAX_HANDOVER_DIRECT_LEDGER_PROOFS).toBe(500 + (10 + 1) + 50 + (50 - 10 + 1) * 2 * 10 + 10 * 9);
    expect(MAX_DIRECT_PAID_LINES).toBe(50);
    expect(MAX_DIRECT_PAYMENT_VERSIONS).toBe(10);
  });

  test("at the line cap the next payment on a NEW line is refused, guided, with nothing written", async () => {
    const seed = await seedDeal("adm-lines");
    await seedEverPaid(seed, MAX_DIRECT_PAID_LINES);
    const feeId = await dealerFee(seed, jod(50));
    const journals = await journalCount(seed);
    await expect(payDirect(seed, feeId)).rejects.toThrow(/already has 50 cost lines.*Nothing has been recorded/s);
    expect(await journalCount(seed)).toBe(journals);
    expect(await directEvents(seed)).toHaveLength(0);
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.directPayment).toBeUndefined();
  });

  test("one below the cap admits the payment, and that line may then be corrected and re-paid past the cap", async () => {
    const seed = await seedDeal("adm-below");
    await seedEverPaid(seed, MAX_DIRECT_PAID_LINES - 1);
    const feeId = await dealerFee(seed, jod(50));
    await payDirect(seed, feeId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD",
    });
    await payDirect(seed, feeId);
    expect(expense(await ledger(seed))).toBe(jod(65));
  });

  test("a line's version cap: the 11th payment version is refused, the 10th is admitted", async () => {
    const seed = await seedDeal("adm-versions");
    const feeId = await dealerFee(seed, jod(50));
    await seed.t.run((ctx) => ctx.db.patch(feeId, { directPaymentVersion: MAX_DIRECT_PAYMENT_VERSIONS }));
    await expect(payDirect(seed, feeId)).rejects.toThrow(/10 times.*Nothing has been recorded/s);
    expect(await journalCount(seed)).toBe(0);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { directPaymentVersion: MAX_DIRECT_PAYMENT_VERSIONS - 1 }));
    await payDirect(seed, feeId);
    expect((await directEvents(seed))[0].eventVersion).toBe(MAX_DIRECT_PAYMENT_VERSIONS);
  });

  /**
   * The worst state the writers can reach: 500 live lines, 50 lines that ever
   * carried a payment (nine at versions 1..9, the rest at version 10, every
   * version reversed, each with a forward event AND a reversal row), all
   * posted. The proof must judge it READY within its derived budget.
   */
  async function worstCase(name: string) {
    const seed = await seedDeal(name);
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 500; i += 1) {
        await ctx.db.insert("financeDealFees", rawLine(seed, { actualAmountMinor: 0 }) as never);
      }
      for (let i = 0; i < MAX_DIRECT_PAID_LINES; i += 1) {
        const version = i < MAX_DIRECT_PAYMENT_VERSIONS - 1 ? i + 1 : MAX_DIRECT_PAYMENT_VERSIONS;
        const feeId = await ctx.db.insert(
          "financeDealFees",
          rawLine(seed, { actualAmountMinor: jod(1), voidedAt: Date.now(), directPaymentVersion: version }) as never
        );
        for (let k = 1; k <= version; k += 1) {
          const base = {
            orgId: seed.orgId, sourceType: "financeDealFees", sourceId: feeId as string, eventVersion: k,
            occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD", payload: {},
            createdBy: seed.userId, createdAt: Date.now(),
          };
          await ctx.db.insert("accountingEvents", {
            ...base, eventType: "HANDOVER_COST_PAID_DIRECT", idempotencyKey: handoverDirectPostKey(feeId, k), status: "REVERSED",
          });
          await ctx.db.insert("accountingEvents", {
            ...base, eventType: "HANDOVER_COST_PAID_DIRECT_REVERSAL", idempotencyKey: handoverDirectReversalKey(feeId, k), status: "POSTED",
          });
        }
      }
    });
    return seed;
  }

  test("the worst state at the caps is READY, not UNAVAILABLE, when everything is posted", async () => {
    const seed = await worstCase("adm-worst");
    const check = await readiness(seed);
    expect(check.reason?.code).toBeUndefined();
    expect(check.status).toBe("READY");
  }, 120_000);

  test("the same worst state with ONE reversal still POSTED blocks (the controls still bite at the caps)", async () => {
    const seed = await worstCase("adm-worst-blocked");
    await seed.t.run(async (ctx) => {
      const event = (await ctx.db.query("accountingEvents").collect()).find(
        (e) => e.eventType === "HANDOVER_COST_PAID_DIRECT" && e.eventVersion === 10
      )!;
      await ctx.db.patch(event._id, { status: "POSTED" });
    });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_DIRECT_REVERSAL_PENDING");
  }, 120_000);

  test("one document under the derived budget the same worst state cannot be judged: UNAVAILABLE, never READY", async () => {
    const seed = await worstCase("adm-worst-tight");
    const verdict = await seed.t.run(async (ctx) => {
      const app = (await ctx.db.get("financeApplications", seed.applicationId))!;
      const fees = await ctx.db.query("financeDealFees").withIndex("by_application_voidedAt", (q) => q.eq("applicationId", seed.applicationId).eq("voidedAt", undefined)).take(501);
      const run = async (limit: number) => {
        try {
          await handoverDirectLedgerRefusal(ctx, app.orgId, app._id, fees, limit);
          return "judged";
        } catch (error) {
          return error instanceof ConvexError ? "refused" : `other: ${String(error)}`;
        }
      };
      return { exact: await run(MAX_HANDOVER_DIRECT_LEDGER_PROOFS), oneLess: await run(MAX_HANDOVER_DIRECT_LEDGER_PROOFS - 1) };
    });
    expect(verdict).toEqual({ exact: "judged", oneLess: "refused" });
  }, 120_000);
});