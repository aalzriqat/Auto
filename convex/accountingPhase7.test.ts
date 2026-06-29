/**
 * Phase 7 tests: financial audit log, segregation of duties, manual journal controls.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedAuditDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Audit Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "aud_user", email: "aud@example.com", name: "Audit User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );
  const asUser = t.withIdentity({ subject: "aud_user", clerkId: "aud_user" });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.now() - 60 * 86400_000, endDate: Date.now() + 30 * 86400_000,
    fiscalYear: 2026, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, period, asUser };
}

describe("Phase 7 — financial audit log", () => {
  test("period open action is logged in audit log", async () => {
    const { t, orgId } = await seedAuditDealer();
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "aud2", email: "aud2@example.com", name: "User2" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Finance", permissions: ["view:sales", "manage:finance", "view:finance"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asUser = t.withIdentity({ subject: "aud2", clerkId: "aud2" });

    await asUser.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.now() + 31 * 86400_000, endDate: Date.now() + 90 * 86400_000,
      fiscalYear: 2026, periodNumber: 2,
    });
    const periods = await asUser.query(api.accountingPeriods.list, { orgId });
    const futurePeriod = periods.find((p) => p.status === "FUTURE")!;
    const logsBefore = await asUser.query(api.financialAudit.listAuditLog, { orgId, actionType: "OPEN_PERIOD" });
    const countBefore = logsBefore.length;

    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: futurePeriod._id });

    const logsAfter = await asUser.query(api.financialAudit.listAuditLog, { orgId, actionType: "OPEN_PERIOD" });
    expect(logsAfter.length).toBe(countBefore + 1);
    // The newest entry must reference the futurePeriod we just opened
    const newest = logsAfter.find((l) => l.resourceId === futurePeriod._id.toString());
    expect(newest).toBeDefined();
    expect(newest!.actionType).toBe("OPEN_PERIOD");
  });

  test("posting an accounting event creates an audit entry", async () => {
    const { orgId, asUser } = await seedAuditDealer();
    const now = Date.now();

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: "exp_audit_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "exp_audit_001_key",
      payload: { expenseId: "exp_audit_001", amountMinor: 25000, currency: "JOD" },
    });

    const logs = await asUser.query(api.financialAudit.listAuditLog, { orgId, actionType: "POST_EVENT" });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].actionType).toBe("POST_EVENT");
  });

  test("audit log is queryable by actor", async () => {
    const { orgId, userId, asUser } = await seedAuditDealer();
    const now = Date.now();

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: "exp_actor_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "exp_actor_001_key",
      payload: { expenseId: "exp_actor_001", amountMinor: 10000, currency: "JOD" },
    });

    const logs = await asUser.query(api.financialAudit.listAuditLog, { orgId, actorId: userId });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.actorId === userId)).toBe(true);
  });
});

describe("Phase 7 — manual journal", () => {
  test("balanced manual journal is accepted", async () => {
    const { orgId, asUser } = await seedAuditDealer();

    const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
    const manualAccounts = accounts.filter((a) => a.allowManualPosting);
    expect(manualAccounts.length).toBeGreaterThanOrEqual(2);

    const result = await asUser.mutation(api.financialAudit.postManualJournal, {
      orgId,
      memo: "Year-end adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 5000 },
      ],
      idempotencyKey: "mj_001",
    });

    expect(result.alreadyPosted).toBe(false);
    expect(result.journalId).toBeTruthy();
  });

  test("unbalanced manual journal is rejected", async () => {
    const { orgId, asUser } = await seedAuditDealer();

    const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
    const manualAccounts = accounts.filter((a) => a.allowManualPosting);

    await expect(
      asUser.mutation(api.financialAudit.postManualJournal, {
        orgId,
        memo: "Bad journal",
        lines: [
          { accountId: manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
          { accountId: manualAccounts[0]._id, debitMinor: 0, creditMinor: 3000 },
        ],
        idempotencyKey: "mj_bad_001",
      })
    ).rejects.toThrow(/unbalanced/i);
  });

  test("reviewer cannot be the same as poster", async () => {
    const { orgId, userId, asUser } = await seedAuditDealer();

    const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
    const manualAccounts = accounts.filter((a) => a.allowManualPosting);

    await expect(
      asUser.mutation(api.financialAudit.postManualJournal, {
        orgId,
        memo: "Self-reviewed journal",
        lines: [
          { accountId: manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
          { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
        ],
        idempotencyKey: "mj_selfreview_001",
        reviewedBy: userId,
      })
    ).rejects.toThrow(/reviewer cannot be the same/i);
  });

  test("manual journal is idempotent", async () => {
    const { orgId, asUser } = await seedAuditDealer();

    const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
    const manualAccounts = accounts.filter((a) => a.allowManualPosting);

    const first = await asUser.mutation(api.financialAudit.postManualJournal, {
      orgId,
      memo: "Idempotent adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 2000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 2000 },
      ],
      idempotencyKey: "mj_idem_001",
    });

    const second = await asUser.mutation(api.financialAudit.postManualJournal, {
      orgId,
      memo: "Idempotent adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 2000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 2000 },
      ],
      idempotencyKey: "mj_idem_001",
    });

    expect(second.alreadyPosted).toBe(true);
    expect(first.resourceId).toBeDefined();
    expect(second.resourceId).toBe(first.resourceId);
  });
});
