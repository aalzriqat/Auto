/**
 * Phase 15 tests — full cash-drawer sessions.
 *
 * Acceptance gates: a session moves open → count → close → approve with
 * variance recorded; variance approval cannot be performed by whoever
 * counted the drawer; the bank deposit on approval posts a balanced entry.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function seedDrawerDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase15 Dealer", createdAt: Date.now() })
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
  const cashierId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p15_cashier", email: "p15cashier@example.com", name: "Cashier" })
  );
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p15_manager", email: "p15manager@example.com", name: "Manager" })
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: cashierId, roleId: ownerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: ownerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asCashier = t.withIdentity({ subject: "p15_cashier", clerkId: "p15_cashier" });
  const asManager = t.withIdentity({ subject: "p15_manager", clerkId: "p15_manager" });

  await asCashier.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asCashier.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asCashier.query(api.accountingPeriods.list, { orgId }))[0];
  await asCashier.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, cashierId, managerId, asCashier, asManager };
}

type Ctx = Awaited<ReturnType<typeof seedDrawerDealer>>;

async function eventsOfType(t: Ctx["t"], orgId: Id<"organizations">, eventType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.eq(q.field("eventType"), eventType))
      .collect()
  );
}

async function linesForEvent(t: Ctx["t"], event: { journalEntryId?: Id<"journalEntries"> }) {
  if (!event.journalEntryId) throw new Error("Event has no journalEntryId");
  const journalEntryId = event.journalEntryId;
  return await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalEntryId)).collect()
  );
}

function totals(lines: { debitMinor: number; creditMinor: number }[]) {
  return {
    debit: lines.reduce((s, l) => s + l.debitMinor, 0),
    credit: lines.reduce((s, l) => s + l.creditMinor, 0),
  };
}

async function accountBySystemKey(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

describe("Phase 15 — opening and movements", () => {
  test("cannot open a second session for the same branch while one is already open", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 50_000 });

    await expect(
      asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 20_000 })
    ).rejects.toThrow(/already open/i);
  });

  test("movements are rejected once the session leaves OPEN", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 50_000 });
    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });

    await expect(
      asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "SALE", amountMinor: 10_000, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/only be recorded while.*OPEN/i);
  });

  test("rejects a non-positive movement amount", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 0 });

    await expect(
      asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "SALE", amountMinor: 0, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/must be a positive/i);
  });
});

describe("Phase 15 — count and close", () => {
  test("an exact count yields zero variance", async () => {
    const { t, orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 50_000 });
    await asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "SALE", amountMinor: 200_000, idempotencyKey: crypto.randomUUID() });
    await asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "PAYOUT", amountMinor: 15_000, idempotencyKey: crypto.randomUUID() });
    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });

    // Expected = 50_000 + 200_000 - 15_000 = 235_000
    const result = await asCashier.mutation(api.cashDrawer.close, { orgId, sessionId, closingCountMinor: 235_000 });
    expect(result.expectedMinor).toBe(235_000);
    expect(result.varianceMinor).toBe(0);

    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.status).toBe("CLOSED");
    expect(session?.closingCountMinor).toBe(235_000);
    expect(session?.varianceMinor).toBe(0);
    expect(session?.closedBy).toBeTruthy();
  });

  test("a shortfall computes a negative variance", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 100_000 });
    await asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "SALE", amountMinor: 50_000, idempotencyKey: crypto.randomUUID() });
    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });

    // Expected 150_000, counted 145_000 -> shortage of 5_000.
    const result = await asCashier.mutation(api.cashDrawer.close, { orgId, sessionId, closingCountMinor: 145_000 });
    expect(result.varianceMinor).toBe(-5_000);
  });

  test("an overage computes a positive variance", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 100_000 });
    await asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "SALE", amountMinor: 50_000, idempotencyKey: crypto.randomUUID() });
    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });

    // Expected 150_000, counted 156_000 -> overage of 6_000.
    const result = await asCashier.mutation(api.cashDrawer.close, { orgId, sessionId, closingCountMinor: 156_000 });
    expect(result.varianceMinor).toBe(6_000);
  });

  test("HANDOVER increases expected cash the same way a sale does", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 0 });
    await asCashier.mutation(api.cashDrawer.recordMovement, { orgId, sessionId, type: "HANDOVER", amountMinor: 30_000, idempotencyKey: crypto.randomUUID() });
    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });

    const result = await asCashier.mutation(api.cashDrawer.close, { orgId, sessionId, closingCountMinor: 30_000 });
    expect(result.expectedMinor).toBe(30_000);
    expect(result.varianceMinor).toBe(0);
  });

  test("close is rejected outside COUNTING and beginCount is rejected outside OPEN", async () => {
    const { orgId, asCashier } = await seedDrawerDealer();
    const sessionId = await asCashier.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 0 });

    await expect(
      asCashier.mutation(api.cashDrawer.close, { orgId, sessionId, closingCountMinor: 0 })
    ).rejects.toThrow(/only a session in counting/i);

    await asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId });
    await expect(
      asCashier.mutation(api.cashDrawer.beginCount, { orgId, sessionId })
    ).rejects.toThrow(/only an open session/i);
  });
});

describe("Phase 15 — variance approval and bank deposit", () => {
  async function closedSession(ctx: Ctx, openingFloatMinor: number, saleMinor: number, closingCountMinor: number) {
    const sessionId = await ctx.asCashier.mutation(api.cashDrawer.open, { orgId: ctx.orgId, openingFloatMinor });
    if (saleMinor > 0) {
      await ctx.asCashier.mutation(api.cashDrawer.recordMovement, {
        orgId: ctx.orgId, sessionId, type: "SALE", amountMinor: saleMinor, idempotencyKey: crypto.randomUUID(),
      });
    }
    await ctx.asCashier.mutation(api.cashDrawer.beginCount, { orgId: ctx.orgId, sessionId });
    await ctx.asCashier.mutation(api.cashDrawer.close, { orgId: ctx.orgId, sessionId, closingCountMinor });
    return sessionId;
  }

  test("the person who closed the count cannot approve its own variance", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 100_000, 100_000);

    await expect(
      ctx.asCashier.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId })
    ).rejects.toThrow(/cannot also approve/i);
  });

  test("a different approver succeeds and posts a balanced DR Bank / CR Cash entry for the counted amount", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId });

    const session = await ctx.t.run((c) => c.db.get(sessionId));
    expect(session?.status).toBe("APPROVED");
    expect(session?.approvedBy).toBeTruthy();

    const events = await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");

    const lines = await linesForEvent(ctx.t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(400_000);
    expect(credit).toBe(400_000);

    const bank = await accountBySystemKey(ctx.t, ctx.orgId, "BANK_ACCOUNT");
    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    expect(lines.find((l) => l.accountId === bank?._id)?.debitMinor).toBe(400_000);
    expect(lines.find((l) => l.accountId === cash?._id)?.creditMinor).toBe(400_000);

    const movements = await ctx.asManager.query(api.cashDrawer.listMovements, { orgId: ctx.orgId, sessionId });
    const deposit = movements.find((m) => m.type === "BANK_DEPOSIT");
    expect(deposit?.amountMinor).toBe(400_000);
  });

  test("approving a zero-count session posts no GL event (nothing to deposit)", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 0, 0);

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId });

    const events = await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED");
    expect(events).toHaveLength(0);

    const session = await ctx.t.run((c) => c.db.get(sessionId));
    expect(session?.status).toBe("APPROVED");
  });

  test("approveVariance is rejected outside CLOSED", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await ctx.asCashier.mutation(api.cashDrawer.open, { orgId: ctx.orgId, openingFloatMinor: 0 });

    await expect(
      ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId })
    ).rejects.toThrow(/only a closed session/i);
  });
});
