import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  ruleEmployeeAdvancePaid,
  ruleEmployeeAdvanceRecovered,
  rulePayrollAccrued,
  rulePayrollPaid,
  validateBalance,
} from "./accounting/postingRules";
import { SYSTEM_KEYS } from "./utils/defaultChart";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// ─── Posting-rule unit tests (pure) ────────────────────────────────────────────

describe("payroll posting rules", () => {
  test("an employee advance debits the asset account, not an expense, and balances", () => {
    const r = ruleEmployeeAdvancePaid({
      advanceId: "a1",
      userId: "u1",
      amountMinor: 20000,
      currency: "JOD",
      paymentMethod: "CASH",
    });
    expect(() => validateBalance(r.lines)).not.toThrow();
    const debit = r.lines.find((l) => l.debitMinor > 0)!;
    const credit = r.lines.find((l) => l.creditMinor > 0)!;
    expect(debit.accountSystemKey).toBe(SYSTEM_KEYS.EMPLOYEE_ADVANCES);
    expect(credit.accountSystemKey).toBe(SYSTEM_KEYS.CASH_ON_HAND);
    expect(debit.debitMinor).toBe(20000);
  });

  test("recovering an advance credits the asset back", () => {
    const r = ruleEmployeeAdvanceRecovered({
      advanceId: "a1",
      userId: "u1",
      amountMinor: 20000,
      currency: "JOD",
      paymentMethod: "CASH",
    });
    expect(() => validateBalance(r.lines)).not.toThrow();
    const credit = r.lines.find((l) => l.creditMinor > 0)!;
    expect(credit.accountSystemKey).toBe(SYSTEM_KEYS.EMPLOYEE_ADVANCES);
  });

  test("payroll accrual is Dr Salaries Expense / Cr Salaries Payable", () => {
    const r = rulePayrollAccrued({ runId: "r1", userId: "u1", amountMinor: 50000, currency: "JOD" });
    expect(() => validateBalance(r.lines)).not.toThrow();
    expect(r.lines.find((l) => l.debitMinor > 0)!.accountSystemKey).toBe(SYSTEM_KEYS.SALARIES_EXPENSE);
    expect(r.lines.find((l) => l.creditMinor > 0)!.accountSystemKey).toBe(SYSTEM_KEYS.SALARIES_PAYABLE);
  });

  test("payslip payment balances with salary + commission − advance = net", () => {
    // salary 50000 + commission 10000 − advance 15000 = net 45000
    const r = rulePayrollPaid({
      itemId: "i1",
      userId: "u1",
      salaryMinor: 50000,
      commissionMinor: 10000,
      advanceRecoveredMinor: 15000,
      netMinor: 45000,
      currency: "JOD",
      paymentMethod: "CASH",
    });
    expect(() => validateBalance(r.lines)).not.toThrow();
    const keys = r.lines.map((l) => l.accountSystemKey);
    expect(keys).toContain(SYSTEM_KEYS.SALARIES_PAYABLE);
    expect(keys).toContain(SYSTEM_KEYS.COMMISSION_PAYABLE);
    expect(keys).toContain(SYSTEM_KEYS.EMPLOYEE_ADVANCES);
  });

  test("payslip with the whole payslip consumed by an advance omits the zero cash leg", () => {
    // salary 20000 − advance 20000 = net 0 → no cash line, still balances.
    const r = rulePayrollPaid({
      itemId: "i1",
      userId: "u1",
      salaryMinor: 20000,
      commissionMinor: 0,
      advanceRecoveredMinor: 20000,
      netMinor: 0,
      currency: "JOD",
      paymentMethod: "CASH",
    });
    expect(() => validateBalance(r.lines)).not.toThrow();
    expect(r.lines.every((l) => !(l.debitMinor === 0 && l.creditMinor === 0))).toBe(true);
  });
});

// ─── Integration ───────────────────────────────────────────────────────────────

async function seedPayrollOrg(t: ReturnType<typeof convexTest>, suffix: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Payroll ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `pay_${suffix}`, email: `${suffix}@example.com`, name: "Emp" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Admin",
      permissions: ["view:payroll", "manage:payroll"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: [],
    })
  );
  return { orgId, userId, asAdmin: t.withIdentity({ subject: `pay_${suffix}`, clerkId: `pay_${suffix}` }) };
}

describe("payroll: employee advances (سلفة)", () => {
  test("recording an advance creates an OUTSTANDING row and a GL asset event (not an expense)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "adv");

    const advanceId = await asAdmin.mutation(api.payroll.recordAdvance, {
      orgId,
      userId,
      amount: 20,
      method: "CASH",
      note: "سلفة عامر",
    });

    const advance = await t.run((ctx) => ctx.db.get(advanceId));
    expect(advance?.status).toBe("OUTSTANDING");
    expect(advance?.amountMinor).toBe(20000); // JOD scale 1000

    // The advance must queue/post an EMPLOYEE_ADVANCE_PAID event, never EXPENSE_POSTED.
    const evt = await t.run(async (ctx) => {
      const posted = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "employeeAdvances").eq("sourceId", advanceId)
        )
        .first();
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `employee_advance_paid_${advanceId}`)
        )
        .first();
      return posted ?? pending;
    });
    expect(evt).not.toBeNull();
    expect(evt?.eventType).toBe("EMPLOYEE_ADVANCE_PAID");

    const expenseEvt = await t.run(async (ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first()
    );
    expect(expenseEvt).toBeNull();
  });

  test("recovering an advance marks it RECOVERED", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "rec");
    const advanceId = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 50 });
    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId, method: "CASH" });
    const advance = await t.run((ctx) => ctx.db.get(advanceId));
    expect(advance?.status).toBe("RECOVERED");
    expect(advance?.recoveredMinor).toBe(advance?.amountMinor);
  });
});

describe("payroll: monthly run (Option A — commissions paid through payroll)", () => {
  test("create → approve → pay settles salary, commission, and recovers an advance", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "run");

    // Salary 500, an outstanding advance 50, and a completed unpaid commission 100.
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 500 });
    await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 50 });
    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VIN-RUN", make: "Kia", model: "K5", year: 2024, color: "White",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 20000, status: "SOLD",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Jane", lastName: "Buyer", email: "buyer.run@example.com",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });

    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });

    const items = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.baseSalaryMinor).toBe(500000);
    expect(item.commissionMinor).toBe(100000);
    expect(item.advanceDeductionMinor).toBe(50000); // whole outstanding advance
    expect(item.grossMinor).toBe(600000);
    expect(item.netMinor).toBe(550000);

    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId });
    // Salary accrual + commission accrual must exist before payment.
    const accruals = await t.run(async (ctx) => {
      const salary = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `payroll_accrued_${item._id}`)
        )
        .first();
      const commission = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
        )
        .first();
      return { salary, commission };
    });
    expect(accruals.salary).not.toBeNull();
    expect(accruals.commission).not.toBeNull();

    await asAdmin.mutation(api.payroll.payRun, { orgId, runId, method: "CASH" });

    // Run paid, advance recovered, commission marked paid, payslip payment posted.
    const after = await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      const sale = await ctx.db.get(saleId);
      const advances = await ctx.db
        .query("employeeAdvances")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .collect();
      const paidEvt = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `payroll_paid_${item._id}`)
        )
        .first();
      return { run, sale, advances, paidEvt };
    });
    expect(after.run?.status).toBe("PAID");
    expect(after.sale?.commissionPaidAt).not.toBeNull();
    expect(after.advances[0].status).toBe("RECOVERED");
    expect(after.paidEvt).not.toBeNull();
  });

  test("a second run for the same period is rejected", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "dup");
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 300 });
    await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    await expect(
      asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 })
    ).rejects.toThrow(/already exists/i);
  });
});

describe("payroll: employee compensation", () => {
  test("setting a salary supersedes the previous active row", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "comp");

    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 500 });
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 600 });

    const active = await t.run(async (ctx) =>
      ctx.db
        .query("employeeCompensation")
        .withIndex("by_org_user_active", (q) =>
          q.eq("orgId", orgId).eq("userId", userId).eq("active", true)
        )
        .collect()
    );
    expect(active).toHaveLength(1);
    expect(active[0].monthlySalaryMinor).toBe(600000);

    const listed = await asAdmin.query(api.payroll.listCompensation, { orgId });
    expect(listed).toHaveLength(1);
    expect(listed[0].monthlySalary).toBe(600);
  });
});
