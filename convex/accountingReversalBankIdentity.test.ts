/**
 * SCRUM-54 — reversing an event-backed posting must keep the physical bank on
 * the reversal's BANK_ACCOUNT line.
 *
 * `reverseAccountingEvent` writes its own journal lines (it does not route
 * through the posting engine) and copies each dimension by hand. A reversal
 * line that drops `bankAccountId` is unattributed bank-control activity, so
 * `getBookBalance` would withhold the balance of a bank whose only history is a
 * posting and its own reversal.
 *
 * The original event, journal and lines are seeded directly to isolate the
 * reversal path. This does not claim that opening-balance journals (which
 * are not accounting-event backed) can be reversed this way.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { reverseAccountingEvent } from "./accounting/reversals";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Reversal Bank Dealer", createdAt: Date.now() })
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
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "rbi_owner", email: "rbi_owner@example.com", name: "Owner" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asOwner = t.withIdentity({ subject: "rbi_owner", clerkId: "rbi_owner" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const accounts = await asOwner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const byKey = (key: string) => {
    const found = accounts.find((a) => a.systemKey === key);
    if (!found) throw new Error(`Account ${key} not seeded`);
    return found._id;
  };
  const bankAccountId = await asOwner.mutation(api.bankAccounts.create, {
    orgId,
    name: "Arab Bank JOD",
    currency: "JOD",
    openingBalanceMinor: 0,
    openingBalanceDate: Date.now(),
    isReconciliationTarget: true,
  });

  return {
    t,
    orgId,
    userId,
    asOwner,
    periodId: period._id,
    bankControlId: byKey("BANK_ACCOUNT"),
    capitalId: byKey("PARTNER_CAPITAL"),
    bankAccountId,
    originalDate: Date.UTC(fiscalYear, 0, 2),
    reversalDate: Date.UTC(fiscalYear, 0, 3),
    asOf: Date.UTC(fiscalYear, 11, 31),
  };
}

type Fx = Awaited<ReturnType<typeof seed>>;

/** A POSTED event whose journal debits the bank and credits capital. */
async function seedPostedBankEvent(fx: Fx, amountMinor: number, bankAccountId: Id<"bankAccounts"> | null = fx.bankAccountId) {
  return fx.t.run(async (ctx) => {
    const now = Date.now();
    const eventId = await ctx.db.insert("accountingEvents", {
      orgId: fx.orgId,
      eventType: "SCRUM54_BANK_RECEIPT",
      sourceType: "scrum54Test",
      sourceId: "receipt-1",
      eventVersion: 1,
      idempotencyKey: "scrum54-bank-receipt-1",
      occurredAt: now,
      accountingDate: fx.originalDate,
      currency: "JOD",
      payload: {},
      status: "POSTED",
      createdBy: fx.userId,
      createdAt: now,
    });
    const journalId = await ctx.db.insert("journalEntries", {
      orgId: fx.orgId,
      accountingEventId: eventId,
      journalNumber: "JE-SCRUM54",
      accountingDate: fx.originalDate,
      periodId: fx.periodId,
      sourceType: "scrum54Test",
      sourceId: "receipt-1",
      category: "SYSTEM",
      memo: "Bank receipt",
      status: "POSTED",
      currency: "JOD",
      postedBy: fx.userId,
      postedAt: now,
      createdAt: now,
    });
    await ctx.db.patch(eventId, { journalEntryId: journalId });
    const lines = [
      { accountId: fx.bankControlId, debitMinor: amountMinor, creditMinor: 0, bankAccountId: bankAccountId ?? undefined },
      { accountId: fx.capitalId, debitMinor: 0, creditMinor: amountMinor, bankAccountId: undefined },
    ];
    for (let i = 0; i < lines.length; i++) {
      await ctx.db.insert("journalLines", {
        orgId: fx.orgId,
        journalEntryId: journalId,
        lineNumber: i + 1,
        currency: "JOD",
        scale: 3,
        accountingDate: fx.originalDate,
        ...lines[i],
      });
      await incrementAccountSnapshot(ctx, {
        orgId: fx.orgId,
        accountId: lines[i].accountId,
        currency: "JOD",
        periodId: fx.periodId,
        debitMinor: lines[i].debitMinor,
        creditMinor: lines[i].creditMinor,
      });
    }
    return { eventId, journalId };
  });
}

describe("SCRUM-54 reversal keeps the physical bank", () => {
  test("the reversal's bank line carries the original bank, so the book balance nets to zero and stays attributed", async () => {
    const fx = await seed();
    const { eventId } = await seedPostedBankEvent(fx, 500_000);

    // Control: the fixture itself is a fully attributed 500,000 before reversal.
    await expect(fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: fx.asOf })).resolves.toMatchObject({
      status: "OK",
      balanceMinor: 500_000,
      unattributedLineCount: 0,
    });

    const { reversalJournalEntryId } = await fx.t.run((ctx) =>
      reverseAccountingEvent(ctx, {
        orgId: fx.orgId,
        originalEventId: eventId,
        reversalDate: fx.reversalDate,
        reason: "SCRUM-54 reversal bank identity",
        actorId: fx.userId,
        idempotencyKey: "scrum54-bank-reversal-1",
      })
    );

    const reversalLines = await fx.t.run((ctx) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversalJournalEntryId as Id<"journalEntries">))
        .collect()
    );
    const bankLine = reversalLines.find((l) => l.accountId === fx.bankControlId);
    expect(bankLine).toMatchObject({ debitMinor: 0, creditMinor: 500_000, bankAccountId: fx.bankAccountId });
    expect(reversalLines.find((l) => l.accountId === fx.capitalId)?.bankAccountId).toBeUndefined();

    await expect(fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: fx.asOf })).resolves.toMatchObject({
      status: "OK",
      balanceMinor: 0,
      unmatchedMinor: 0,
      unattributedLineCount: 0,
    });
  });

  test("reversing an unstamped legacy bank line preserves its missing identity and never reports a physical bank balance", async () => {
    const fx = await seed();
    const { eventId } = await seedPostedBankEvent(fx, 500_000, null);

    await expect(fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: fx.asOf })).resolves.toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY",
      balanceMinor: null,
      unmatchedMinor: 500_000,
      unattributedLineCount: 1,
    });

    const { reversalJournalEntryId } = await fx.t.run((ctx) =>
      reverseAccountingEvent(ctx, {
        orgId: fx.orgId,
        originalEventId: eventId,
        reversalDate: fx.reversalDate,
        reason: "Reverse legacy bank receipt without inventing an identity",
        actorId: fx.userId,
        idempotencyKey: "scrum54-legacy-bank-reversal-1",
      })
    );

    const reversalLines = await fx.t.run((ctx) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversalJournalEntryId as Id<"journalEntries">))
        .collect()
    );
    expect(reversalLines.find((line) => line.accountId === fx.bankControlId)?.bankAccountId).toBeUndefined();
    await expect(fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: fx.asOf })).resolves.toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY",
      balanceMinor: null,
      unmatchedMinor: 0,
      unattributedLineCount: 2,
    });
  });
});
