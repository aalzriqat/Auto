import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { REQUIRED_SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedAccountingSetupDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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

describe("SCRUM-226 — dead-lettered outbox rows reach the operator", () => {
  type Seed = Awaited<ReturnType<typeof seedAccountingSetupDealer>>;

  async function insertFailed(
    seed: Pick<Seed, "t" | "orgId" | "userId">,
    key: string,
    createdAt = Date.now(),
    overrides: { kind?: "POST" | "REVERSE"; eventType?: string; sourceType?: string } = {}
  ) {
    const { t, orgId, userId } = seed;
    return t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: overrides.kind ?? "POST",
        status: "FAILED",
        idempotencyKey: key,
        accountingDate: createdAt,
        actorId: userId,
        attempts: 10,
        lastError: "chart of accounts was not initialized",
        createdAt,
        eventType: overrides.eventType ?? "EXPENSE_POSTED",
        sourceType: overrides.sourceType ?? "expenses",
        sourceId: key,
        eventVersion: 1,
        occurredAt: createdAt,
        currency: "JOD",
        payload: { internalAmountMinor: 123_000 },
      })
    );
  }

  test("a FAILED row is exposed with its failure reason, without the payload", async () => {
    const seed = await seedAccountingSetupDealer();
    await insertFailed(seed, "dead_1");

    const setupStatus = await seed.asUser.query(api.accountingSetup.status, { orgId: seed.orgId });

    expect(setupStatus.failedEvents).toHaveLength(1);
    expect(setupStatus.failedEvents[0].status).toBe("FAILED");
    expect(setupStatus.failedEvents[0].reason).toBe("chart of accounts was not initialized");
    expect(setupStatus.failedEvents[0].retryable).toBe(true);
    expect(setupStatus.hasMoreFailedEvents).toBe(false);
    expect("payload" in setupStatus.failedEvents[0]).toBe(false);
    expect("lastError" in setupStatus.failedEvents[0]).toBe(false);
  });

  test("a FAILED row for a retired posting is not retryable (reviveFailedEntry refuses it)", async () => {
    const seed = await seedAccountingSetupDealer();
    await insertFailed(seed, "retired_1", Date.now(), {
      eventType: "COLLECTION_PAYMENT",
      sourceType: "transactions",
    });
    // A REVERSE row of the same retired family is exempt, exactly as in the revive path.
    await insertFailed(seed, "retired_rev", Date.now() + 1, {
      kind: "REVERSE",
      eventType: "COLLECTION_PAYMENT",
      sourceType: "transactions",
    });

    const { failedEvents } = await seed.asUser.query(api.accountingSetup.status, { orgId: seed.orgId });

    expect(failedEvents.find((e) => e.sourceId === "retired_1")?.retryable).toBe(false);
    expect(failedEvents.find((e) => e.sourceId === "retired_rev")?.retryable).toBe(true);
  });

  test("the FAILED sample is bounded and reports overflow", async () => {
    const seed = await seedAccountingSetupDealer();
    const now = Date.now();
    for (let i = 0; i < 12; i++) await insertFailed(seed, `dead_${i}`, now + i);

    const setupStatus = await seed.asUser.query(api.accountingSetup.status, { orgId: seed.orgId });

    expect(setupStatus.failedEvents).toHaveLength(10);
    expect(setupStatus.hasMoreFailedEvents).toBe(true);
  });

  test("another organization's FAILED rows are never exposed", async () => {
    const mine = await seedAccountingSetupDealer();
    const other = await seedAccountingSetupDealer();
    await insertFailed(mine, "mine");

    const otherStatus = await other.asUser.query(api.accountingSetup.status, { orgId: other.orgId });
    expect(otherStatus.failedEvents).toEqual([]);
    expect((await mine.asUser.query(api.accountingSetup.status, { orgId: mine.orgId })).failedEvents).toHaveLength(1);
  });

  test("a view-only user sees no FAILED rows (retry is MANAGE_FINANCE)", async () => {
    const seed = await seedAccountingSetupDealer();
    const { t, orgId } = seed;
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "viewer_only", email: "v@example.com", name: "Viewer" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "Finance Viewer", permissions: ["view:finance"] });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    });
    await insertFailed(seed, "dead_v");

    const viewer = t.withIdentity({ subject: "viewer_only", clerkId: "viewer_only" });
    const setupStatus = await viewer.query(api.accountingSetup.status, { orgId });

    expect(setupStatus.failedEvents).toEqual([]);
  });
});