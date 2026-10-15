/**
 * Phase 15 tests — full cash-drawer sessions.
 *
 * Acceptance gates: a session moves open → count → close → approve with
 * variance recorded; variance approval cannot be performed by whoever
 * counted the drawer; the bank deposit on approval posts a balanced entry.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { reverseAccountingEvent } from "./accounting/reversals";
import { outboxRows, settleOutbox } from "../test-utils/outboxWork";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function seedDrawerDealer(openPeriod = true) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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
  if (openPeriod) await openFullYearPeriod(asCashier, orgId);

  return { t, orgId, cashierId, managerId, asCashier, asManager };
}

async function openFullYearPeriod(asUser: ReturnType<ReturnType<typeof convexTestWithComponents>["withIdentity"]>, orgId: Id<"organizations">) {
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
}

type Ctx = Awaited<ReturnType<typeof seedDrawerDealer>>;

async function insertBank(
  ctx: Ctx,
  overrides: Partial<{
    orgId: Id<"organizations">; currency: string; isActive: boolean; isDeleted: boolean; name: string; isReconciliationTarget: boolean;
  }> = {}
) {
  const now = Date.now();
  return await ctx.t.run((c) =>
    c.db.insert("bankAccounts", {
      orgId: overrides.orgId ?? ctx.orgId,
      name: overrides.name ?? "Operating bank",
      currency: overrides.currency ?? "JOD",
      openingBalanceMinor: 0,
      openingBalanceDate: now,
      isActive: overrides.isActive ?? true,
      isReconciliationTarget: overrides.isReconciliationTarget ?? false,
      createdBy: ctx.managerId,
      createdAt: now,
      updatedAt: now,
      isDeleted: overrides.isDeleted,
    })
  );
}

/** Every table an approval could write to, so a refusal can prove it wrote none. */
async function approvalEffects(ctx: Ctx, sessionId: Id<"cashDrawerSessions">) {
  return await ctx.t.run(async (c) => ({
    session: await c.db.get(sessionId),
    movements: (await c.db.query("cashMovements").collect()).filter((m) => m.type === "BANK_DEPOSIT").length,
    events: (await c.db.query("accountingEvents").collect()).length,
    pending: (await c.db.query("pendingAccountingEvents").collect()).length,
    journals: (await c.db.query("journalEntries").collect()).length,
    lines: (await c.db.query("journalLines").collect()).length,
    snapshots: (await c.db.query("accountBalanceSnapshots").collect()).map((s) => [s.accountId, s.runningDebitMinor, s.runningCreditMinor]),
  }));
}

async function eventsOfType(t: Ctx["t"], orgId: Id<"organizations">, eventType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", eventType))
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

    const bankAccountId = await insertBank(ctx);
    await expect(
      ctx.asCashier.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId })
    ).rejects.toThrow(/cannot also approve/i);
  });

  test("a different approver succeeds and posts a balanced DR Bank / CR Cash entry for the counted amount", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
    const bankAccountId = await insertBank(ctx, { isReconciliationTarget: true });

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId });

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
    const bankLine = lines.find((l) => l.accountId === bank?._id);
    const cashLine = lines.find((l) => l.accountId === cash?._id);
    expect(bankLine?.debitMinor).toBe(400_000);
    expect(cashLine?.creditMinor).toBe(400_000);
    // The physical bank is named on the bank-control line only.
    expect(bankLine?.bankAccountId).toBe(bankAccountId);
    expect(cashLine?.bankAccountId).toBeUndefined();
    expect((events[0].payload as { bankAccountId?: string }).bankAccountId).toBe(bankAccountId);

    const movements = await ctx.asManager.query(api.cashDrawer.listMovements, { orgId: ctx.orgId, sessionId });
    const deposit = movements.find((m) => m.type === "BANK_DEPOSIT");
    expect(deposit?.amountMinor).toBe(400_000);
    expect(deposit?.bankAccountId).toBe(bankAccountId);

    // The attributed deposit is readable as that bank's book balance.
    await expect(
      ctx.asManager.query(api.bankAccounts.getBookBalance, { orgId: ctx.orgId, asOf: Date.now() + 86_400_000 })
    ).resolves.toMatchObject({ status: "OK", balanceMinor: 400_000, unattributedLineCount: 0 });
  });

  // Engine-level: `reverseAccountingEvent` is called directly; no user route
  // reverses a cash drawer deposit yet.
  test("reverseAccountingEvent on the posted deposit credits the same physical bank", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
    const bankAccountId = await insertBank(ctx);
    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId });
    const [event] = await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED");

    const { reversalJournalEntryId } = await ctx.t.run((c) =>
      reverseAccountingEvent(c, {
        orgId: ctx.orgId,
        originalEventId: event._id,
        reversalDate: Date.now(),
        reason: "SCRUM-54 cash drawer deposit reversal",
        actorId: ctx.managerId,
        idempotencyKey: "scrum54-cash-drawer-reversal",
      })
    );
    const reversalLines = await ctx.t.run((c) =>
      c.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversalJournalEntryId)).collect()
    );
    const bank = await accountBySystemKey(ctx.t, ctx.orgId, "BANK_ACCOUNT");
    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    expect(reversalLines.find((l) => l.accountId === bank?._id)).toMatchObject({ creditMinor: 400_000, bankAccountId });
    expect(reversalLines.find((l) => l.accountId === cash?._id)?.bankAccountId).toBeUndefined();
  });

  // convex-test rolls back a mutation that throws, so these prove the refusal and
  // the unchanged CLOSED end state - not that validation runs before the first
  // write. That ordering is read from `approveVariance`, not asserted here.
  describe("a deposit naming no acceptable physical bank is refused and leaves the session CLOSED with nothing posted", () => {
    async function refused(
      label: string,
      pickBank: (ctx: Ctx) => Promise<Id<"bankAccounts"> | undefined>,
      message: RegExp
    ) {
      const ctx = await seedDrawerDealer();
      const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
      const bankAccountId = await pickBank(ctx);
      const before = await approvalEffects(ctx, sessionId);

      await expect(
        ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId }),
        label
      ).rejects.toThrow(message);

      expect(await approvalEffects(ctx, sessionId)).toEqual(before);
      expect(before.session?.status).toBe("CLOSED");
    }

    test("no bank is refused - none is defaulted even when exactly one bank exists", async () => {
      await refused("missing", async (ctx) => {
        await insertBank(ctx);
        return undefined;
      }, /select the bank account/i);
    });

    test("another organization's bank is refused", async () => {
      await refused("foreign", async (ctx) => {
        const otherOrg = await ctx.t.run((c) => c.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() }));
        return await insertBank(ctx, { orgId: otherOrg });
      }, /not found in this organization/i);
    });

    test("an inactive bank is refused", async () => {
      await refused("inactive", (ctx) => insertBank(ctx, { isActive: false }), /inactive/i);
    });

    test("a deleted bank is refused", async () => {
      await refused("deleted", (ctx) => insertBank(ctx, { isDeleted: true }), /not found in this organization/i);
    });

    test("a bank in another currency is refused", async () => {
      await refused("wrong currency", (ctx) => insertBank(ctx, { currency: "USD" }), /denominated in USD/i);
    });
  });

  test("a deposit approved while no period is open is queued with its bank and posts it later", async () => {
    const ctx = await seedDrawerDealer(false);
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
    const bankAccountId = await insertBank(ctx);

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId });

    expect(await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED")).toHaveLength(0);
    const queued = await outboxRows(ctx.t, ctx.orgId);
    expect(queued).toHaveLength(1);
    expect((queued[0].payload as { bankAccountId?: string }).bankAccountId).toBe(bankAccountId);

    await openFullYearPeriod(ctx.asCashier, ctx.orgId);
    await settleOutbox(ctx.t, ctx.orgId);

    const [event] = await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED");
    expect(event?.status).toBe("POSTED");
    const bank = await accountBySystemKey(ctx.t, ctx.orgId, "BANK_ACCOUNT");
    const lines = await linesForEvent(ctx.t, event);
    expect(lines.find((l) => l.accountId === bank?._id)?.bankAccountId).toBe(bankAccountId);
  });

  test("the bank picker offers only acceptable banks, without account identifiers, to an approver", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
    const good = await insertBank(ctx, { name: "Good bank" });
    await insertBank(ctx, { name: "Inactive", isActive: false });
    await insertBank(ctx, { name: "Deleted", isDeleted: true });
    await insertBank(ctx, { name: "Dollar", currency: "USD" });
    const otherOrg = await ctx.t.run((c) => c.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() }));
    await insertBank(ctx, { orgId: otherOrg, name: "Foreign" });

    const options = await ctx.asManager.query(api.cashDrawer.listDepositBankOptions, { orgId: ctx.orgId, sessionId });
    expect(options).toEqual([{ _id: good, name: "Good bank", currency: "JOD" }]);
  });

  test("viewing finance alone does not expose the bank picker", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 400_000, 400_000);
    await insertBank(ctx);
    const viewerId = await ctx.t.run((c) => c.db.insert("users", { clerkId: "p15_viewer", email: "p15viewer@example.com", name: "Viewer" }));
    const viewerRoleId = await ctx.t.run((c) => c.db.insert("roles", { orgId: ctx.orgId, name: "Viewer", permissions: ["view:finance"] }));
    await ctx.t.run((c) => c.db.insert("memberships", { orgId: ctx.orgId, userId: viewerId, roleId: viewerRoleId }));
    const asViewer = ctx.t.withIdentity({ subject: "p15_viewer", clerkId: "p15_viewer" });

    // Control: this identity really holds view:finance and is a member, so the
    // refusal below is about the missing approval permission, nothing else.
    await expect(asViewer.query(api.cashDrawer.list, { orgId: ctx.orgId })).resolves.toHaveLength(1);
    await expect(
      asViewer.query(api.cashDrawer.listDepositBankOptions, { orgId: ctx.orgId, sessionId })
    ).rejects.toThrow(/Missing required permissions: approve:requests/);
  });

  test("approving a zero-count session posts no GL event (nothing to deposit)", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 0, 0);

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId });

    const events = await eventsOfType(ctx.t, ctx.orgId, "CASH_DRAWER_DEPOSITED");
    expect(events).toHaveLength(0);

    const session = await ctx.t.run((c) => c.db.get(sessionId));
    expect(session?.status).toBe("APPROVED");
    // Nothing is deposited, so no bank is needed and no deposit movement exists.
    expect((await approvalEffects(ctx, sessionId)).movements).toBe(0);
  });

  test("a bank supplied with a zero count is ignored: no bank stamp, no deposit, approval succeeds", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await closedSession(ctx, 0, 0, 0);
    const bankAccountId = await insertBank(ctx);

    await ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId, bankAccountId });

    const effects = await approvalEffects(ctx, sessionId);
    expect(effects.session?.status).toBe("APPROVED");
    expect(effects.movements).toBe(0);
    expect(effects.events).toBe(0);
    expect(effects.lines).toBe(0);
  });

  test("approveVariance is rejected outside CLOSED", async () => {
    const ctx = await seedDrawerDealer();
    const sessionId = await ctx.asCashier.mutation(api.cashDrawer.open, { orgId: ctx.orgId, openingFloatMinor: 0 });

    await expect(
      ctx.asManager.mutation(api.cashDrawer.approveVariance, { orgId: ctx.orgId, sessionId })
    ).rejects.toThrow(/only a closed session/i);
  });
});
