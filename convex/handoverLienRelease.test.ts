import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { evaluateClosingReadiness } from "./utils/financedSaleRecognition";
import { executionFeeBindRefusal } from "./utils/executionFeePosition";

/**
 * SCRUM-707 — a LIEN_RELEASE handover cost (now offered in the manual-add menu)
 * runs through the real writer and the real posting engine exactly like every
 * other handover cost: custody-paid or direct-paid it posts ONCE, blocks the
 * deal's closing until paid, reverses on void — and can never be mistaken for
 * the finance company's execution fee.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: ReturnType<TestConvex["withIdentity"]>;
}

async function seedDeal(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Lien ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `lr_user_${suffix}`, email: `lr${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `lr_emp_${suffix}`, email: `emp${suffix}@x.com`, name: "Emp" }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: ownerRole }));
  const { applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `LRVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "LR", lastName: "Customer" });
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
  const asUser = t.withIdentity({ subject: `lr_user_${suffix}` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    openImmediately: true,
  });
  return { t, orgId, employeeId, applicationId, asUser };
}

async function lienRelease(
  seed: Seed,
  actualAmountMinor: number,
  extra: { paidBy?: "DEALER" | "EMPLOYEE"; custodyId?: Id<"financeDealCustody"> } = {}
) {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId, applicationId: seed.applicationId,
    feeType: "LIEN_RELEASE", paidBy: extra.paidBy ?? "DEALER", paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", deductedFromSettlement: false,
    actualAmountMinor, custodyId: extra.custodyId, source: "MANUAL",
  });
}

async function openCustody(seed: Seed, issued: number) {
  return await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
    idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
    userId: seed.employeeId, issuedMinor: issued, method: "CASH",
  });
}

async function payDirect(seed: Seed, feeId: Id<"financeDealFees">, amountMinor: number) {
  return await seed.asUser.mutation(api.financeDealCosts.recordDirectFeePayment, {
    orgId: seed.orgId, feeId, method: "BANK_TRANSFER", paidAt: Date.now() - DAY,
    expectedAmountMinor: amountMinor, idempotencyKey: crypto.randomUUID(),
  });
}

async function expenseBalance(seed: Seed): Promise<number> {
  return await seed.t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter(
      (a) => a.orgId === seed.orgId && a.systemKey === SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE
    );
    let total = 0;
    for (const entry of (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === seed.orgId)) {
      if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
      for (const l of lines) if (accounts.some((a) => a._id === l.accountId)) total += l.debitMinor - l.creditMinor;
    }
    return total;
  });
}

async function eventCount(seed: Seed, eventType: string): Promise<number> {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect()).filter(
      (e) => e.eventType === eventType
    ).length
  );
}

const paidCheck = async (seed: Seed) =>
  await seed.t.run(async (ctx) => {
    const app = (await ctx.db.get("financeApplications", seed.applicationId))!;
    const result = await evaluateClosingReadiness(ctx, app, { settlesDirect: false, currency: "JOD" });
    return result.readiness.checks.find((c) => c.key === "HANDOVER_COSTS_PAID")!;
  });

describe("LIEN_RELEASE through the real writer", () => {
  test("direct-paid: blocks closing until paid, posts once, voids by reversal", async () => {
    const seed = await seedDeal("direct");
    const feeId = await lienRelease(seed, jod(40));
    const blocked = await paidCheck(seed);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.feeIds).toEqual([feeId]);

    await payDirect(seed, feeId, jod(40));
    expect(await expenseBalance(seed)).toBe(jod(40));
    expect(await eventCount(seed, "HANDOVER_COST_PAID_DIRECT")).toBe(1);
    expect((await paidCheck(seed)).status).toBe("READY");

    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
    expect(await expenseBalance(seed)).toBe(0);
    expect(await eventCount(seed, "HANDOVER_COST_PAID_DIRECT")).toBe(1);
  });

  test("custody-paid: posts once from custody, satisfies the closing check, voids by reversal", async () => {
    const seed = await seedDeal("custody");
    const custodyId = await openCustody(seed, jod(100));
    const feeId = await lienRelease(seed, jod(40), { paidBy: "EMPLOYEE", custodyId });
    expect(await expenseBalance(seed)).toBe(jod(40));
    expect(await eventCount(seed, "CUSTODY_FEE_PAID")).toBe(1);
    expect((await paidCheck(seed)).status).toBe("READY");

    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
    expect(await expenseBalance(seed)).toBe(0);
    expect(await eventCount(seed, "CUSTODY_FEE_PAID")).toBe(1);
  });

  test("a dealer-paid line recorded but never paid keeps the deal blocked", async () => {
    const seed = await seedDeal("unpaid");
    await lienRelease(seed, jod(40));
    const check = await paidCheck(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_UNPAID");
  });
});

describe("a LIEN_RELEASE line is never the finance-company execution fee", () => {
  const line = {
    _id: "fee1", feeType: "LIEN_RELEASE", paidBy: "DEALER", paidTo: "FINANCE_COMPANY",
    deductedFromSettlement: false, accountingTreatment: "FINANCE_COMPANY_COMMISSION",
    currency: "JOD", actualAmountMinor: jod(40),
  } as unknown as Parameters<typeof executionFeeBindRefusal>[0];

  test("the bind predicate refuses it even when every other field matches an execution fee", () => {
    expect(executionFeeBindRefusal(line, "JOD")).toBe("Only a finance-company fee can be the execution fee.");
    expect(executionFeeBindRefusal({ ...line, feeType: "FINANCE_COMPANY_FEE" }, "JOD")).toBeNull();
  });

  test("bindExecutionFeeLine refuses a recorded LIEN_RELEASE line", async () => {
    const seed = await seedDeal("bind");
    const feeId = await lienRelease(seed, jod(40));
    await expect(
      seed.asUser.mutation(api.financeDealCosts.bindExecutionFeeLine, { orgId: seed.orgId, feeId })
    ).rejects.toThrow();
    const row = await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId));
    expect(row?.executionFeeBinding).toBeUndefined();
  });
});
