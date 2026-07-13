/**
 * Phase 12 tests — partner equity as immutable transactions.
 *
 * Acceptance gates: contribution/draw/distribution each post a balanced
 * entry; currentBalance derives from transactions (on top of a frozen legacy
 * base); direct balance edits are gone from the mutation surface; the Phase 6
 * migration PARTNER_DRAW/CAPITAL_INJECTION skip gap is closed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedEquityDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase12 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p12_owner", email: "p12owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p12_owner", clerkId: "p12_owner" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asOwner };
}

type Ctx = Awaited<ReturnType<typeof seedEquityDealer>>;

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

async function partnerBalanceMinor(asOwner: Ctx["asOwner"], orgId: Id<"organizations">, partnerId: Id<"partnerEquity">) {
  const page = await asOwner.query(api.partnerEquity.list, {
    orgId, paginationOpts: { numItems: 100, cursor: null },
  });
  const row = page.page.find((p) => p._id === partnerId);
  if (!row) throw new Error("Partner not in list");
  return row.balanceMinor;
}

describe("Phase 12 — capital contribution", () => {
  test("contribution posts DR Cash / CR Partner Capital and raises the derived balance", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Partner A",
    });

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "CONTRIBUTION", amountMinor: 1_000_000, paymentMethod: "CASH",
    });

    const events = await eventsOfType(t, orgId, "CAPITAL_CONTRIBUTED");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");

    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(1_000_000);
    expect(credit).toBe(1_000_000);

    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const capital = await accountBySystemKey(t, orgId, "PARTNER_CAPITAL");
    expect(lines.find((l) => l.accountId === cash?._id)?.debitMinor).toBe(1_000_000);
    expect(lines.find((l) => l.accountId === capital?._id)?.creditMinor).toBe(1_000_000);

    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(1_000_000);
  });

  test("adding a partner with an opening contribution posts it to the GL", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Partner B", openingContributionMinor: 500_000, paymentMethod: "BANK_TRANSFER",
    });

    const events = await eventsOfType(t, orgId, "CAPITAL_CONTRIBUTED");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    expect(lines.find((l) => l.accountId === bank?._id)?.debitMinor).toBe(500_000);

    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(500_000);
  });

  test("rejects an unsupported payment method", async () => {
    const { orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Partner C",
    });

    await expect(
      asOwner.mutation(api.partnerEquity.recordEquityMovement, {
        orgId, partnerId, type: "CONTRIBUTION", amountMinor: 1_000_000, paymentMethod: "OTHER" as any,
      })
    ).rejects.toThrow(/Validator error/i);

    await expect(
      asOwner.mutation(api.partnerEquity.recordEquityMovement, {
        orgId, partnerId, type: "CONTRIBUTION", amountMinor: 1_000_000, paymentMethod: "WIRE" as any,
      })
    ).rejects.toThrow(/Validator error/i);
  });
});

describe("Phase 12 — partner draw", () => {
  test("draw posts DR Partner Drawings / CR Cash and lowers the derived balance", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Drawer", openingContributionMinor: 800_000,
    });

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "DRAW", amountMinor: 300_000, paymentMethod: "CASH",
    });

    const events = await eventsOfType(t, orgId, "PARTNER_DREW");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(300_000);
    expect(credit).toBe(300_000);

    const drawings = await accountBySystemKey(t, orgId, "PARTNER_DRAWINGS");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    expect(lines.find((l) => l.accountId === drawings?._id)?.debitMinor).toBe(300_000);
    expect(lines.find((l) => l.accountId === cash?._id)?.creditMinor).toBe(300_000);

    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(500_000);
  });

  test("a draw paid by cheque credits the bank account, not cheques-in-hand", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Cheque Drawer", openingContributionMinor: 400_000,
    });

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "DRAW", amountMinor: 100_000, paymentMethod: "CHEQUE",
    });

    const events = await eventsOfType(t, orgId, "PARTNER_DREW");
    const lines = await linesForEvent(t, events[0]);
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const chequesInHand = await accountBySystemKey(t, orgId, "CHEQUES_IN_HAND");
    expect(lines.find((l) => l.accountId === bank?._id)?.creditMinor).toBe(100_000);
    expect(lines.find((l) => l.accountId === chequesInHand?._id)).toBeUndefined();
  });

  test("a draw exceeding the partner's balance is rejected", async () => {
    const { orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Overdrawer", openingContributionMinor: 100_000,
    });

    await expect(
      asOwner.mutation(api.partnerEquity.recordEquityMovement, {
        orgId, partnerId, type: "DRAW", amountMinor: 150_000,
      })
    ).rejects.toThrow(/exceeds this partner's equity balance/i);
  });
});

describe("Phase 12 — profit distribution", () => {
  test("distribution posts DR Retained Earnings / CR Partner Capital with no cash line", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Profit Taker",
    });

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "PROFIT_DISTRIBUTION", amountMinor: 250_000,
    });

    const events = await eventsOfType(t, orgId, "PROFIT_DISTRIBUTED");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(250_000);
    expect(credit).toBe(250_000);

    const retained = await accountBySystemKey(t, orgId, "RETAINED_EARNINGS");
    const capital = await accountBySystemKey(t, orgId, "PARTNER_CAPITAL");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    expect(lines.find((l) => l.accountId === retained?._id)?.debitMinor).toBe(250_000);
    expect(lines.find((l) => l.accountId === capital?._id)?.creditMinor).toBe(250_000);
    expect(lines.find((l) => l.accountId === cash?._id)).toBeUndefined();
    expect(lines.find((l) => l.accountId === bank?._id)).toBeUndefined();

    // Distribution raises the balance the partner can subsequently draw.
    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(250_000);
    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "DRAW", amountMinor: 250_000,
    });
    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(0);
  });
});

describe("Phase 12 — no direct balance edits", () => {
  test("update no longer accepts initialCapital/currentBalance", async () => {
    const { orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Immutable",
    });

    // The args validator itself must reject the old balance-edit fields.
    await expect(
      asOwner.mutation(api.partnerEquity.update, {
        orgId, equityId: partnerId, currentBalance: 999_999,
      } as never)
    ).rejects.toThrow();

    await asOwner.mutation(api.partnerEquity.update, {
      orgId, equityId: partnerId, partnerName: "Renamed", notes: "ok",
    });
  });

  test("a legacy stored balance survives as the base under derived math", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();
    // Pre-Phase-12 row: major-unit balance (500 JOD = 500_000 minor at scale 3).
    const partnerId = await t.run((ctx) =>
      ctx.db.insert("partnerEquity", {
        orgId, partnerName: "Legacy Partner", initialCapital: 500, currentBalance: 500,
      })
    );

    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(500_000);

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "DRAW", amountMinor: 200_000,
    });
    expect(await partnerBalanceMinor(asOwner, orgId, partnerId)).toBe(300_000);
  });

  test("a partner with a nonzero GL-backed balance cannot be removed", async () => {
    const { orgId, asOwner } = await seedEquityDealer();
    const partnerId = await asOwner.mutation(api.partnerEquity.add, {
      orgId, partnerName: "Sticky", openingContributionMinor: 50_000,
    });

    await expect(
      asOwner.mutation(api.partnerEquity.remove, { orgId, equityId: partnerId })
    ).rejects.toThrow(/still has an equity balance/i);

    await asOwner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId, partnerId, type: "DRAW", amountMinor: 50_000,
    });
    await asOwner.mutation(api.partnerEquity.remove, { orgId, equityId: partnerId });
  });
});

describe("Phase 12 — legacy migration gap", () => {
  test("PARTNER_DRAW and CAPITAL_INJECTION legacy transactions now migrate with balanced entries", async () => {
    const { t, orgId, asOwner } = await seedEquityDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(),
        category: "PARTNER_DRAW", description: "Legacy partner draw",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "IN", amount: 250, date: Date.now(),
        category: "CAPITAL_INJECTION", description: "Legacy capital injection",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(2);
    expect(result.skipped).toBe(0);

    const drewEvents = await eventsOfType(t, orgId, "PARTNER_DREW");
    const contribEvents = await eventsOfType(t, orgId, "CAPITAL_CONTRIBUTED");
    expect(drewEvents).toHaveLength(1);
    expect(contribEvents).toHaveLength(1);

    // 100 JOD → 100_000 minor at scale 3; 250 JOD → 250_000.
    const drewTotals = totals(await linesForEvent(t, drewEvents[0]));
    expect(drewTotals.debit).toBe(100_000);
    expect(drewTotals.debit).toBe(drewTotals.credit);

    const contribTotals = totals(await linesForEvent(t, contribEvents[0]));
    expect(contribTotals.debit).toBe(250_000);
    expect(contribTotals.debit).toBe(contribTotals.credit);
  });
});
