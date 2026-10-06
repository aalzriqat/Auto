import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { REQUIRED_SYSTEM_KEYS } from "./utils/defaultChart";
import { truncateByCodePoints } from "./accountingSetup";
import { quiesceScheduler, scheduledClaimsFor, withFrozenScheduler } from "../test-utils/outboxWork";

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

  function listFailed(seed: Pick<Seed, "asUser" | "orgId">, numItems = 10, cursor: string | null = null) {
    return seed.asUser.query(api.accountingSetup.listFailedEvents, {
      orgId: seed.orgId,
      paginationOpts: { numItems, cursor },
    });
  }

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

    const failed = await listFailed(seed);

    expect(failed.page).toHaveLength(1);
    expect(failed.page[0].status).toBe("FAILED");
    expect(failed.page[0].reason).toBe("chart of accounts was not initialized");
    expect(failed.page[0].retryable).toBe(true);
    expect(failed.isDone).toBe(true);
    expect("payload" in failed.page[0]).toBe(false);
    expect("lastError" in failed.page[0]).toBe(false);
  });

  test("status no longer carries FAILED rows (they are paged through listFailedEvents)", async () => {
    const seed = await seedAccountingSetupDealer();
    await insertFailed(seed, "dead_s");

    const setupStatus = await seed.asUser.query(api.accountingSetup.status, { orgId: seed.orgId });

    expect("failedEvents" in setupStatus).toBe(false);
    expect("hasMoreFailedEvents" in setupStatus).toBe(false);
  });

  // The invariant (SCRUM-226-1): every revivable FAILED posting is reachable
  // and retryable whatever newer terminal failures exist. The old status sample
  // returned only the newest 10 FAILED rows, so 10 newer retired POSTs hid it.
  test("an old revivable FAILED row behind 10 newer retired ones is reachable and retryable", async () => {
    const seed = await seedAccountingSetupDealer();
    const base = Date.now();
    const revivableId = await insertFailed(seed, "old_revivable", base);
    for (let i = 0; i < 10; i++) {
      await insertFailed(seed, `retired_${i}`, base + 1 + i, {
        eventType: "COLLECTION_PAYMENT",
        sourceType: "transactions",
      });
    }

    const first = await listFailed(seed, 10);
    expect(first.page.some((e) => e._id === revivableId)).toBe(false);
    expect(first.isDone).toBe(false);
    const second = await listFailed(seed, 10, first.continueCursor);
    const hit = second.page.find((e) => e._id === revivableId);
    expect(hit?.retryable).toBe(true);
    expect(second.isDone).toBe(true);

    await quiesceScheduler(seed.t);
    await withFrozenScheduler(async () => {
      const outcome = await seed.asUser.mutation(api.accountingOutbox.retryFailed, {
        orgId: seed.orgId,
        pendingEventId: revivableId,
      });
      expect(outcome).toEqual({ retryQueued: true });
      expect(await scheduledClaimsFor(seed.t, revivableId)).toHaveLength(1);
    });

    // The revived row leaves the FAILED list; the retired ones remain.
    const after = await listFailed(seed, 50);
    expect(after.page.some((e) => e._id === revivableId)).toBe(false);
    expect(after.page).toHaveLength(10);
  });

  test("the page boundary: exactly 10 rows is one done page, 11 needs a second", async () => {
    const seed = await seedAccountingSetupDealer();
    const now = Date.now();
    for (let i = 0; i < 10; i++) await insertFailed(seed, `b_${i}`, now + i);
    const ten = await listFailed(seed, 10);
    expect(ten.page).toHaveLength(10);
    expect(ten.isDone).toBe(true);

    await insertFailed(seed, "b_10", now + 10);
    const page1 = await listFailed(seed, 10);
    expect(page1.page).toHaveLength(10);
    expect(page1.isDone).toBe(false);
    const page2 = await listFailed(seed, 10, page1.continueCursor);
    expect(page2.page).toHaveLength(1);
    expect(page2.isDone).toBe(true);
  });

  test("lastError truncation keeps a surrogate pair at the 300 cap whole", async () => {
    const seed = await seedAccountingSetupDealer();
    const { t, orgId, userId } = seed;
    const now = Date.now();
    // 299 code units then a 2-unit emoji: a UTF-16 slice(0, 300) would split it.
    const lastError = `${"a".repeat(299)}\u{1F600}tail`;
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "FAILED", idempotencyKey: "emoji", accountingDate: now,
        actorId: userId, attempts: 10, lastError, createdAt: now, eventType: "EXPENSE_POSTED",
        sourceType: "expenses", sourceId: "emoji", eventVersion: 1, occurredAt: now,
        currency: "JOD", payload: {},
      })
    );

    const reason = (await listFailed(seed)).page[0].reason ?? "";

    expect(Array.from(reason)).toHaveLength(300);
    expect(reason.endsWith("\u{1F600}")).toBe(true);
    expect(truncateByCodePoints("x".repeat(300), 300)).toBe("x".repeat(300));
    expect(truncateByCodePoints("\u{1F600}\u{1F600}", 1)).toBe("\u{1F600}");
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

    const { page } = await listFailed(seed);

    expect(page.find((e) => e.sourceId === "retired_1")?.retryable).toBe(false);
    expect(page.find((e) => e.sourceId === "retired_rev")?.retryable).toBe(true);
  });

  test("another organization's FAILED rows are never exposed", async () => {
    // Both orgs live in ONE database: separate convexTest instances hand out
    // identical ids, which would make this isolation check vacuous.
    const mine = await seedAccountingSetupDealer();
    const otherOrgId = await mine.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    await insertFailed(mine, "mine");
    await insertFailed({ t: mine.t, orgId: otherOrgId, userId: mine.userId }, "theirs");

    const page = (await listFailed(mine)).page;
    expect(page).toHaveLength(1);
    expect(page[0].sourceId).toBe("mine");
    // A member of one org cannot read another org's list by passing its id.
    await expect(
      mine.asUser.query(api.accountingSetup.listFailedEvents, {
        orgId: otherOrgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
  });

  test("a view-only user is refused the FAILED list (retry is MANAGE_FINANCE)", async () => {
    const seed = await seedAccountingSetupDealer();
    const { t, orgId } = seed;
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "viewer_only", email: "v@example.com", name: "Viewer" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "Finance Viewer", permissions: ["view:finance"] });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    });
    await insertFailed(seed, "dead_v");

    const viewer = t.withIdentity({ subject: "viewer_only", clerkId: "viewer_only" });
    await expect(
      viewer.query(api.accountingSetup.listFailedEvents, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
    // The status read the viewer is allowed still works.
    await expect(viewer.query(api.accountingSetup.status, { orgId })).resolves.toBeDefined();
  });
});