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
      permissions: ["view:payroll", "manage:payroll", "view:commissions", "manage:commissions"],
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

  test("the same unpaid commission captured by two different-period runs is only paid once", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "twoperiod");

    // No salary — just one completed, unpaid commission of 100.
    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VIN-2P", make: "Kia", model: "K5", year: 2024, color: "White",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 20000, status: "SOLD",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Jane", lastName: "Buyer", email: "buyer.2p@example.com",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });

    // createRun has no period filter, so BOTH runs snapshot the same sale.
    const junRun = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 6 });
    const julRun = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });

    // Pay June first — settles the commission.
    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId: junRun });
    await asAdmin.mutation(api.payroll.payRun, { orgId, runId: junRun, method: "CASH" });

    // Now pay July — the commission is already paid, so it must settle NOTHING.
    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId: julRun });
    await asAdmin.mutation(api.payroll.payRun, { orgId, runId: julRun, method: "CASH" });

    const julItems = await asAdmin.query(api.payroll.listRunItems, { orgId, runId: julRun });
    // The stale snapshot said 100000; the re-validated payment must be 0.
    expect(julItems[0].commissionMinor).toBe(0);
    expect(julItems[0].netMinor).toBe(0);

    // And July must NOT post a second payslip payment (nothing left to pay).
    const julPaidEvt = await t.run(async (ctx) => {
      const item = julItems[0];
      return ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `payroll_paid_${item._id}`)
        )
        .first();
    });
    expect(julPaidEvt).toBeNull();

    // The sale itself was paid exactly once.
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionPaidAt).not.toBeNull();
  });

  test("a run rejects an empty period instead of creating a blocking zero-item draft", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "empty");
    // No salaries, no commissions → nothing to pay.
    await expect(
      asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 })
    ).rejects.toThrow(/nothing to pay/i);
    // And the period is NOT blocked afterwards: once there is something to
    // pay, the same period creates fine (no phantom draft exists).
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 100 });
    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    expect(runId).toBeDefined();
  });

  test("cancelling a draft frees its period; approved runs cannot be cancelled", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "cancel");
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 300 });

    const first = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    // Period is taken while the draft lives…
    await expect(
      asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 })
    ).rejects.toThrow(/already exists/i);
    // …and freed once it is cancelled.
    await asAdmin.mutation(api.payroll.cancelRun, { orgId, runId: first });
    const second = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    expect(second).toBeDefined();

    // Once approved, the GL has accruals — cancel must refuse.
    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId: second });
    await expect(
      asAdmin.mutation(api.payroll.cancelRun, { orgId, runId: second })
    ).rejects.toThrow(/only a draft/i);
  });

  test("a sale cancelled after drafting is NOT paid by the run", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "cxl");

    // Commission-only payslip.
    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VIN-CXL", make: "Kia", model: "K5", year: 2024, color: "White",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 20000, status: "SOLD",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Jane", lastName: "Buyer", email: "buyer.cxl@example.com",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });

    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId });

    // The sale is voided before payday — its accrual would be reversed, so the
    // run must not hand out cash for it or debit the (gone) payable.
    await t.run((ctx) => ctx.db.patch(saleId, { status: "CANCELLED" }));
    await asAdmin.mutation(api.payroll.payRun, { orgId, runId, method: "CASH" });

    const items = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(items[0].commissionMinor).toBe(0);
    expect(items[0].netMinor).toBe(0);
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionPaidAt ?? null).toBeNull();
    const paidEvt = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `payroll_paid_${items[0]._id}`)
        )
        .first()
    );
    expect(paidEvt).toBeNull();
  });

  test("a commission paid directly from the Commissions page is not paid again by payroll", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "direct");
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 200 });

    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VIN-DIR", make: "Kia", model: "K5", year: 2024, color: "White",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 20000, status: "SOLD",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Jane", lastName: "Buyer", email: "buyer.dir@example.com",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });

    // Draft captures salary 200 + commission 100.
    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 7 });
    // Commission is then paid DIRECTLY, outside payroll.
    await asAdmin.mutation(api.sales.markCommissionPaid, { orgId, saleId, paymentMethod: "CASH" });

    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId });
    await asAdmin.mutation(api.payroll.payRun, { orgId, runId, method: "BANK_TRANSFER" });

    // The run pays ONLY the salary; the direct payment record is untouched.
    const items = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(items[0].commissionMinor).toBe(0);
    expect(items[0].grossMinor).toBe(200000);
    expect(items[0].netMinor).toBe(200000);
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionPaymentMethod).toBe("CASH");
  });

  test("a retroactive run pays the salary that applied in that period, not today's", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "retro");

    // Salary was 600 from June 1st, raised to 800 later (today).
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 600 });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("employeeCompensation").collect();
      await ctx.db.patch(rows[0]._id, { effectiveFrom: Date.UTC(2026, 5, 1) });
    });
    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 800 });

    // A June run created after the raise must use the June salary (600).
    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 6 });
    const items = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(items[0].baseSalaryMinor).toBe(600000);
  });

  test("an advance recovered between create and pay is not double-recovered", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "advstale");

    await asAdmin.mutation(api.payroll.setCompensation, { orgId, userId, monthlySalary: 200 });
    const advanceId = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 50 });

    // Draft snapshots a 50 advance deduction (gross 200 → net 150).
    const runId = await asAdmin.mutation(api.payroll.createRun, { orgId, periodYear: 2026, periodMonth: 8 });
    const before = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(before[0].advanceDeductionMinor).toBe(50000);
    expect(before[0].netMinor).toBe(150000);

    // The advance is recovered out-of-band before the run is paid.
    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId, method: "CASH" });

    await asAdmin.mutation(api.payroll.approveRun, { orgId, runId });
    await asAdmin.mutation(api.payroll.payRun, { orgId, runId, method: "CASH" });

    // Nothing outstanding to recover now → full salary paid, no advance leg.
    const after = await asAdmin.query(api.payroll.listRunItems, { orgId, runId });
    expect(after[0].advanceDeductionMinor).toBe(0);
    expect(after[0].netMinor).toBe(200000);
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
