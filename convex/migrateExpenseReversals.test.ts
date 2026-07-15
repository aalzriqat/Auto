/**
 * Backfill of expenses.reversedAt for rows reversed before the field existed.
 * Without it, an already-reversed expense keeps looking like one deleted before
 * it ever posted, and its original month stays retroactively restated to zero in
 * the operational P&L while the income statement still reports it.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");
const OWNER_PERMS = [
  "view:finance", "manage:finance", "view:reports",
  "view:expenses", "create:expenses", "edit:expenses", "delete:expenses", "view:vehicles",
];

async function seedDealer(tag: string) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Org ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}@example.com`, name: "Owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMS, isSystemOwnerRole: true })
  );
  const userId = await t.run((ctx) =>
    ctx.db.query("users").filter((q) => q.eq(q.field("clerkId"), `${tag}_owner`)).first().then((u) => u!._id)
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asOwner = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fy = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fy, 0, 1), endDate: Date.UTC(fy, 11, 31, 23, 59, 59, 999), fiscalYear: fy, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { t, orgId, userId, asOwner };
}

const YEAR = new Date().getUTCFullYear();
const JAN_START = Date.UTC(YEAR, 0, 1);
const JAN_END = Date.UTC(YEAR, 0, 31, 23, 59, 59, 999);

describe("backfillExpenseReversedAt", () => {
  test("restores a legacy reversed expense to the month it posted", async () => {
    const { t, orgId, asOwner } = await seedDealer("legacy");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Office supplies", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });
    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Duplicate" });

    // Simulate a row reversed before reversedAt existed.
    await t.run((ctx) => ctx.db.patch(expenseId, { reversedAt: undefined }));
    const broken = await asOwner.query(api.reports.getExpensesReport, { orgId, startDate: JAN_START, endDate: JAN_END });
    expect(broken.totalExpenses).toBeCloseTo(0, 6); // the bug, reproduced

    const result = await t.mutation(internal.migrateExpenseReversals.backfillExpenseReversedAt, {});
    expect(result.updatedCount).toBe(1);

    const patched = await t.run((ctx) => ctx.db.get(expenseId));
    expect(patched?.reversedAt).toBeDefined();

    // January reports again, matching the ledger.
    const fixed = await asOwner.query(api.reports.getExpensesReport, { orgId, startDate: JAN_START, endDate: JAN_END });
    const ledger = await asOwner.query(api.accountingReports.incomeStatement, { orgId, fromDate: JAN_START, toDate: JAN_END });
    expect(fixed.totalExpenses).toBeCloseTo(500, 6);
    expect(ledger.totalExpenses / 1000).toBeCloseTo(500, 6);
  });

  test("is idempotent and leaves an already-stamped row alone", async () => {
    const { t, orgId, asOwner } = await seedDealer("idem");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Supplies", amount: 200, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });
    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Duplicate" });
    const stampedAt = (await t.run((ctx) => ctx.db.get(expenseId)))?.reversedAt;

    const first = await t.mutation(internal.migrateExpenseReversals.backfillExpenseReversedAt, {});
    const second = await t.mutation(internal.migrateExpenseReversals.backfillExpenseReversedAt, {});

    expect(first.updatedCount).toBe(0);
    expect(first.skippedAlreadySet).toBe(1);
    expect(second.updatedCount).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(expenseId)))?.reversedAt).toBe(stampedAt);
  });

  test("a reversed prep-expense RECLASSIFICATION never marks the expense itself reversed", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("reclass");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Detailing", amount: 400, date: Date.UTC(YEAR, 0, 10),
      category: "DETAILING", status: "PAID", paymentMethod: "CASH",
    });

    // A reversal that shares sourceType "expenses" AND sourceId with the
    // expense's own posting, but reverses a reclassification instead.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "JOURNAL_REVERSAL",
        sourceType: "expenses",
        sourceId: expenseId.toString(),
        eventVersion: 2,
        idempotencyKey: `reclass_reversal_${expenseId}`,
        occurredAt: Date.now(),
        accountingDate: Date.UTC(YEAR, 5, 1),
        currency: "JOD",
        payload: { originalEventType: "VEHICLE_PREP_EXPENSE_RECLASSIFIED", reason: "Reclass undone" },
        payloadHash: "x",
        status: "POSTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const result = await t.mutation(internal.migrateExpenseReversals.backfillExpenseReversedAt, {});

    expect(result.updatedCount).toBe(0);
    expect(result.skippedNotExpensePosting).toBe(1);
    // The live expense must not be marked reversed — that would credit it out
    // of the P&L in June while the ledger still carries it.
    expect((await t.run((ctx) => ctx.db.get(expenseId)))?.reversedAt).toBeUndefined();
    const report = await asOwner.query(api.reports.getExpensesReport, { orgId, startDate: JAN_START, endDate: JAN_END });
    expect(report.totalExpenses).toBeCloseTo(400, 6);
  });
});
