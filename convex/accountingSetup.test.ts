import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { REQUIRED_SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedAccountingSetupDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Accounting Setup Dealer", createdAt: Date.now() })
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
      clerkId: "accounting_setup_user",
      email: "setup@example.com",
      name: "Setup User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Admin",
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  return {
    t,
    orgId,
    userId,
    asUser: t.withIdentity({ subject: "accounting_setup_user", clerkId: "accounting_setup_user" }),
  };
}

describe("accounting setup status", () => {
  test("reports missing setup for a new accounting org", async () => {
    const { orgId, asUser } = await seedAccountingSetupDealer();

    const setupStatus = await asUser.query(api.accountingSetup.status, { orgId });

    expect(setupStatus.chartInitialized).toBe(false);
    expect(setupStatus.systemAccountsValid).toBe(false);
    expect(setupStatus.missingSystemAccountKeys).toHaveLength(REQUIRED_SYSTEM_KEYS.length);
    expect(setupStatus.currentOpenPeriod).toBeNull();
    expect(setupStatus.recentPeriods).toEqual([]);
    expect(setupStatus.pendingEvents).toEqual([]);
    expect(setupStatus.hasMorePendingEvents).toBe(false);
  });

  test("summarizes chart, open period, and pending outbox without exposing raw payloads", async () => {
    const { t, orgId, userId, asUser } = await seedAccountingSetupDealer();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const now = Date.now();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: new Date(now).getUTCFullYear(),
      periodNumber: 1,
      startDate: now - 86_400_000,
      endDate: now + 86_400_000,
      openImmediately: true,
    });

    await t.run(async (ctx) => {
      for (let index = 0; index < 12; index++) {
        await ctx.db.insert("pendingAccountingEvents", {
          orgId,
          kind: "POST",
          status: "PENDING",
          idempotencyKey: `setup_pending_${index}`,
          accountingDate: now,
          actorId: userId,
          reason: "No open accounting period at operation time",
          attempts: index,
          lastError: "internal posting stack should stay server-side",
          createdAt: now + index,
          eventType: "EXPENSE_POSTED",
          sourceType: "expenses",
          sourceId: `expense_${index}`,
          eventVersion: 1,
          occurredAt: now,
          currency: "JOD",
          payload: { internalAmountMinor: 123_000 },
        });
      }
    });

    const setupStatus = await asUser.query(api.accountingSetup.status, { orgId });

    expect(setupStatus.chartInitialized).toBe(true);
    expect(setupStatus.systemAccountsValid).toBe(true);
    expect(setupStatus.missingSystemAccountKeys).toEqual([]);
    expect(setupStatus.currentOpenPeriod?.status).toBe("OPEN");
    expect(setupStatus.recentPeriods).toHaveLength(1);
    expect(setupStatus.pendingEvents).toHaveLength(10);
    expect(setupStatus.hasMorePendingEvents).toBe(true);
    expect("payload" in setupStatus.pendingEvents[0]).toBe(false);
    expect("lastError" in setupStatus.pendingEvents[0]).toBe(false);
  });
});
