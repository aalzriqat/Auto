import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { toMinorUnits, fromMinorUnits, scaleForCurrency, isValidMinorAmount, assertSameCurrency, makeMoney, moneyFromDecimal } from "./utils/money";
import { SYSTEM_KEYS, REQUIRED_SYSTEM_KEYS } from "./utils/defaultChart";

async function seedPhase1Dealer() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase 1 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "p1_user",
      email: "p1@example.com",
      name: "P1 User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Admin",
      permissions: [
        "view:sales",
        "manage:finance",
        "view:finance",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  return {
    t,
    orgId,
    userId,
    asUser: t.withIdentity({ subject: "p1_user", clerkId: "p1_user" }),
  };
}

// ─── Money precision tests ────────────────────────────────────────────────────

describe("Phase 1 — money precision", () => {
  test("JOD scale is 3 decimal places", () => {
    expect(scaleForCurrency("JOD")).toBe(3);
  });

  test("USD scale is 2 decimal places", () => {
    expect(scaleForCurrency("USD")).toBe(2);
  });

  test("JPY scale is 0 decimal places", () => {
    expect(scaleForCurrency("JPY")).toBe(0);
  });

  test("JOD 0.001 round-trips without loss", () => {
    const minor = toMinorUnits(0.001, "JOD");
    expect(minor).toBe(1);
    expect(fromMinorUnits(minor, "JOD")).toBe(0.001);
  });

  test("JOD 1000.500 round-trips without loss", () => {
    const minor = toMinorUnits(1000.5, "JOD");
    expect(minor).toBe(1000500);
    expect(fromMinorUnits(minor, "JOD")).toBe(1000.5);
  });

  test("USD 99.99 round-trips without loss", () => {
    const minor = toMinorUnits(99.99, "USD");
    expect(minor).toBe(9999);
    expect(fromMinorUnits(minor, "USD")).toBe(99.99);
  });

  test("JPY 1500 round-trips without loss (zero decimal)", () => {
    const minor = toMinorUnits(1500, "JPY");
    expect(minor).toBe(1500);
    expect(fromMinorUnits(minor, "JPY")).toBe(1500);
  });

  test("isValidMinorAmount rejects float", () => {
    expect(isValidMinorAmount(1.5)).toBe(false);
  });

  test("isValidMinorAmount rejects negative", () => {
    expect(isValidMinorAmount(-1)).toBe(false);
  });

  test("isValidMinorAmount accepts zero", () => {
    expect(isValidMinorAmount(0)).toBe(true);
  });

  test("isValidMinorAmount accepts large safe integer", () => {
    expect(isValidMinorAmount(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("assertSameCurrency throws on mismatch", () => {
    expect(() => assertSameCurrency("JOD", "USD")).toThrow(/Currency mismatch/);
  });

  test("assertSameCurrency passes on same currency", () => {
    expect(() => assertSameCurrency("JOD", "JOD")).not.toThrow();
  });

  test("assertSameCurrency is case-insensitive", () => {
    expect(() => assertSameCurrency("jod", "JOD")).not.toThrow();
  });

  test("makeMoney stores correct scale for JOD", () => {
    const m = makeMoney(1000, "JOD");
    expect(m.scale).toBe(3);
    expect(m.amountMinor).toBe(1000);
    expect(m.currency).toBe("JOD");
  });

  test("moneyFromDecimal converts 10.500 JOD correctly", () => {
    const m = moneyFromDecimal(10.5, "JOD");
    expect(m.amountMinor).toBe(10500);
    expect(m.scale).toBe(3);
  });
});

// ─── Chart of accounts tests ──────────────────────────────────────────────────

describe("Phase 1 — chart of accounts", () => {
  test("initializing twice throws", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    await expect(
      asUser.mutation(api.chartOfAccounts.initialize, { orgId })
    ).rejects.toThrow(/already initialized/i);
  });

  test("initialized chart contains required system accounts", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const { valid, missing } = await asUser.query(api.chartOfAccounts.validateSystemAccounts, { orgId });
    expect(missing).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test("all required system keys are present after initialize", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    for (const key of REQUIRED_SYSTEM_KEYS) {
      const account = await t.run((ctx) =>
        ctx.db
          .query("chartOfAccounts")
          .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", key))
          .unique()
      );
      expect(account, `System key ${key} not found`).not.toBeNull();
      expect(account!.active).toBe(true);
    }
  });

  test("can list accounts by type after initialize", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const assets = await asUser.query(api.chartOfAccounts.list, { orgId, type: "ASSET" });
    expect(assets.length).toBeGreaterThan(0);
    assets.forEach((a) => expect(a.type).toBe("ASSET"));
  });

  test("can create a custom account", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const accountId = await asUser.mutation(api.chartOfAccounts.create, {
      orgId,
      code: "6999",
      name: "Custom Office Expense",
      type: "EXPENSE",
      normalBalance: "DEBIT",
    });
    expect(accountId).toBeTruthy();
  });

  test("duplicate account code is rejected", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    await expect(
      asUser.mutation(api.chartOfAccounts.create, {
        orgId,
        code: "1100",
        name: "Duplicate",
        type: "ASSET",
        normalBalance: "DEBIT",
      })
    ).rejects.toThrow(/already exists/i);
  });

  test("cannot deactivate a system account", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const cashAccount = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND))
        .unique()
    );
    expect(cashAccount).not.toBeNull();

    await expect(
      asUser.mutation(api.chartOfAccounts.update, {
        orgId,
        accountId: cashAccount!._id,
        active: false,
      })
    ).rejects.toThrow(/cannot be deactivated/i);
  });
});

// ─── Accounting periods tests ─────────────────────────────────────────────────

describe("Phase 1 — accounting periods", () => {
  const JAN_2026_START = new Date("2026-01-01T00:00:00.000Z").getTime();
  const JAN_2026_END = new Date("2026-01-31T23:59:59.999Z").getTime();
  const FEB_2026_START = new Date("2026-02-01T00:00:00.000Z").getTime();
  const FEB_2026_END = new Date("2026-02-28T23:59:59.999Z").getTime();

  test("can create and open a period", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
    });
    expect(periodId).toBeTruthy();

    const period = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(period?.status).toBe("FUTURE");

    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId });
    const opened = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(opened?.status).toBe("OPEN");
  });

  test("can create period as immediately open", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    const period = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(period?.status).toBe("OPEN");
  });

  test("duplicate year/period number is rejected", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
    });

    await expect(
      asUser.mutation(api.accountingPeriods.create, {
        orgId,
        fiscalYear: 2026,
        periodNumber: 1,
        startDate: JAN_2026_START,
        endDate: JAN_2026_END,
      })
    ).rejects.toThrow(/already exists/i);
  });

  test("start date must be before end date", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    await expect(
      asUser.mutation(api.accountingPeriods.create, {
        orgId,
        fiscalYear: 2026,
        periodNumber: 1,
        startDate: JAN_2026_END,
        endDate: JAN_2026_START,
      })
    ).rejects.toThrow(/before end date/i);
  });

  test("can close and lock a period", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });
    const closed = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closedAt).toBeTruthy();

    await asUser.mutation(api.accountingPeriods.lock, { orgId, periodId });
    const locked = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(locked?.status).toBe("LOCKED");
  });

  async function makeOwner(t: Awaited<ReturnType<typeof seedPhase1Dealer>>["t"], orgId: any, userId: any) {
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .unique();
      await ctx.db.patch(membership!.roleId, { name: "OWNER", isSystemOwnerRole: true });
    });
  }

  test("can reopen a closed period with reason", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });
    await makeOwner(t, orgId, userId);
    await asUser.mutation(api.accountingPeriods.reopen, {
      orgId,
      periodId,
      reason: "Correction required for Jan closing entry",
    });

    const period = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(period?.status).toBe("OPEN");
    expect(period?.reopenReason).toBe("Correction required for Jan closing entry");
    expect(period?.reopenedAt).toBeTruthy();
  });

  test("a non-owner cannot reopen a closed period even with a reason", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });

    await expect(
      asUser.mutation(api.accountingPeriods.reopen, {
        orgId,
        periodId,
        reason: "Trying to reopen without owner rights",
      })
    ).rejects.toThrow(/only the organization owner/i);
  });

  test("locked periods cannot be reopened", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });
    await asUser.mutation(api.accountingPeriods.lock, { orgId, periodId });
    await makeOwner(t, orgId, userId);

    await expect(
      asUser.mutation(api.accountingPeriods.reopen, {
        orgId,
        periodId,
        reason: "Oops",
      })
    ).rejects.toThrow(/locked/i);
  });

  test("reopen without reason is rejected", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });
    await makeOwner(t, orgId, userId);

    await expect(
      asUser.mutation(api.accountingPeriods.reopen, { orgId, periodId, reason: "   " })
    ).rejects.toThrow(/reason/i);
  });

  test("close is blocked by a pending manual journal approval, without an override reason", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const account = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND))
        .unique()
    );

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId,
        status: "PENDING_APPROVAL",
        memo: "Awaiting review",
        lines: [{ accountId: account!._id, debitMinor: 1000, creditMinor: 0 }],
        idempotencyKey: "test-blocker-1",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    await expect(
      asUser.mutation(api.accountingPeriods.close, { orgId, periodId })
    ).rejects.toThrow(/awaiting approval/i);
  });

  test("close is blocked by a FAILED (dead-lettered) outbox event, not just PENDING ones", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: "POST",
        status: "FAILED",
        idempotencyKey: "test-failed-outbox-1",
        accountingDate: JAN_2026_START + 1,
        actorId: userId,
        attempts: 10,
        lastError: "chart of accounts not initialized",
        createdAt: Date.now(),
        sourceType: "sales",
        sourceId: "test-sale-1",
      })
    );

    const checklist = await asUser.query(api.accountingPeriods.closeChecklist, { orgId, periodId });
    expect(checklist.canClose).toBe(false);
    expect(checklist.failedOutboxEventCount).toBe(1);
    expect(checklist.blockers.some((b) => /FAILED to post/i.test(b))).toBe(true);

    await expect(
      asUser.mutation(api.accountingPeriods.close, { orgId, periodId })
    ).rejects.toThrow(/FAILED to post/i);

    // The owner-override path (already exercised for other blockers below)
    // must still cover this one — the checklist is generic, not blocker-specific.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .unique();
      await ctx.db.patch(membership!.roleId, { name: "OWNER", isSystemOwnerRole: true });
    });
    await asUser.mutation(api.accountingPeriods.close, {
      orgId,
      periodId,
      overrideReason: "Failed event will be retried after fixing the underlying cause",
    });
    const closed = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(closed?.status).toBe("CLOSED");
  });

  test("a non-owner cannot override a blocked close even with a reason", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const account = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND))
        .unique()
    );

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId,
        status: "PENDING_APPROVAL",
        memo: "Awaiting review",
        lines: [{ accountId: account!._id, debitMinor: 1000, creditMinor: 0 }],
        idempotencyKey: "test-blocker-2",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    // asUser only has manage:finance via a custom "Finance Admin" role, not
    // the system OWNER role — the override branch must reject them.
    await expect(
      asUser.mutation(api.accountingPeriods.close, {
        orgId,
        periodId,
        overrideReason: "Known rounding discrepancy, accepted",
      })
    ).rejects.toThrow(/only the organization owner/i);
  });

  test("the org owner can override a blocked close with a reason", async () => {
    const { t, orgId, asUser, userId } = await seedPhase1Dealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const account = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND))
        .unique()
    );

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId,
        status: "PENDING_APPROVAL",
        memo: "Awaiting review",
        lines: [{ accountId: account!._id, debitMinor: 1000, creditMinor: 0 }],
        idempotencyKey: "test-blocker-3",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    // Promote the existing user's role to the system owner role.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .unique();
      await ctx.db.patch(membership!.roleId, { name: "OWNER", isSystemOwnerRole: true });
    });

    await asUser.mutation(api.accountingPeriods.close, {
      orgId,
      periodId,
      overrideReason: "Known rounding discrepancy, accepted",
    });

    const closed = await asUser.query(api.accountingPeriods.get, { orgId, periodId });
    expect(closed?.status).toBe("CLOSED");
  });

  test("assertPostingAllowed rejects posting into a FUTURE period", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();

    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
    });

    await expect(
      t.run(async (ctx) => {
        const { assertPostingAllowed } = await import("./accountingPeriods");
        return assertPostingAllowed(ctx, orgId, JAN_2026_START + 1000);
      })
    ).rejects.toThrow(/not been opened/i);
  });

  test("assertPostingAllowed rejects posting into a CLOSED period", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });

    await expect(
      t.run(async (ctx) => {
        const { assertPostingAllowed } = await import("./accountingPeriods");
        return assertPostingAllowed(ctx, orgId, JAN_2026_START + 1000);
      })
    ).rejects.toThrow(/CLOSED/i);
  });

  test("assertPostingAllowed rejects posting when no period covers the date", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();

    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    await expect(
      t.run(async (ctx) => {
        const { assertPostingAllowed } = await import("./accountingPeriods");
        return assertPostingAllowed(ctx, orgId, FEB_2026_START + 1000);
      })
    ).rejects.toThrow(/No accounting period found/i);
  });

  test("assertPostingAllowed succeeds for an OPEN period", async () => {
    const { t, orgId, asUser } = await seedPhase1Dealer();

    const periodId = await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });

    const resultPeriodId = await t.run(async (ctx) => {
      const { assertPostingAllowed } = await import("./accountingPeriods");
      return assertPostingAllowed(ctx, orgId, JAN_2026_START + 1000);
    });
    expect(resultPeriodId).toBe(periodId);
  });

  test("can list multiple periods", async () => {
    const { orgId, asUser } = await seedPhase1Dealer();

    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 1,
      startDate: JAN_2026_START,
      endDate: JAN_2026_END,
      openImmediately: true,
    });
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 2,
      startDate: FEB_2026_START,
      endDate: FEB_2026_END,
    });

    const all = await asUser.query(api.accountingPeriods.list, { orgId });
    expect(all).toHaveLength(2);

    const open = await asUser.query(api.accountingPeriods.list, { orgId, status: "OPEN" });
    expect(open).toHaveLength(1);
    expect(open[0].periodNumber).toBe(1);
  });
});
