/**
 * Phase 41 tests — bank accounts.
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts. Opening balance is a reporting-layer number (no journal entry),
 * so these tests assert CRUD, single-reconciliation-target enforcement, and
 * the book-balance math against seeded ledger activity.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase41 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p41_owner", email: "p41owner@example.com", name: "Owner" })
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

  const asOwner = t.withIdentity({ subject: "p41_owner", clerkId: "p41_owner" });

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

describe("bankAccounts.create / list", () => {
  test("creates a bank account and lists it", async () => {
    const { orgId, asOwner } = await seedDealer();

    const id = await asOwner.mutation(api.bankAccounts.create, {
      orgId,
      name: "Main Operating Account",
      currency: "JOD",
      openingBalanceMinor: 1_000_000,
      openingBalanceDate: Date.now(),
    });

    const accounts = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]._id).toBe(id);
    expect(accounts[0].isReconciliationTarget).toBe(false);
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId } = await seedDealer();
    await expect(
      t.mutation(api.bankAccounts.create, {
        orgId, name: "X", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
      })
    ).rejects.toThrow();
  });
});

describe("bankAccounts.setReconciliationTarget", () => {
  test("only one bank account can be the reconciliation target at a time", async () => {
    const { orgId, asOwner } = await seedDealer();

    const accountA = await asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "Account A", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
      isReconciliationTarget: true,
    });
    const accountB = await asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "Account B", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
    });

    let accounts = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(accounts.find((a) => a._id === accountA)?.isReconciliationTarget).toBe(true);
    expect(accounts.find((a) => a._id === accountB)?.isReconciliationTarget).toBe(false);

    await asOwner.mutation(api.bankAccounts.setReconciliationTarget, { orgId, bankAccountId: accountB });

    accounts = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(accounts.find((a) => a._id === accountA)?.isReconciliationTarget).toBe(false);
    expect(accounts.find((a) => a._id === accountB)?.isReconciliationTarget).toBe(true);
  });
});

describe("bankAccounts.deactivate", () => {
  test("soft-deletes the account and clears it from the list", async () => {
    const { orgId, asOwner } = await seedDealer();
    const id = await asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "To Deactivate", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
    });

    await asOwner.mutation(api.bankAccounts.deactivate, { orgId, bankAccountId: id });

    const accounts = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(accounts).toHaveLength(0);
  });
});

describe("bankAccounts.getBookBalance", () => {
  test("returns null when no account is the reconciliation target", async () => {
    const { orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "Reference Only", currency: "JOD", openingBalanceMinor: 500_000, openingBalanceDate: Date.now(),
    });

    const balance = await asOwner.query(api.bankAccounts.getBookBalance, { orgId });
    expect(balance).toBeNull();
  });

  test("book balance = opening balance + net BANK_ACCOUNT ledger activity since the opening date", async () => {
    const { t, orgId, asOwner, userId } = await seedDealer();
    const openingDate = Date.now() - 30 * 24 * 60 * 60 * 1000;

    await asOwner.mutation(api.bankAccounts.create, {
      orgId,
      name: "Operating Account",
      currency: "JOD",
      openingBalanceMinor: 1_000_000,
      openingBalanceDate: openingDate,
      isReconciliationTarget: true,
    });

    const bankAccountChart = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT"))
        .unique()
    );
    const retainedEarnings = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RETAINED_EARNINGS"))
        .unique()
    );

    // Directly seed a POSTED journal entry that debits BANK_ACCOUNT — this
    // simulates real GL activity landing on the shared control account after
    // the opening date, bypassing the domain mutations that would normally
    // create it (deposits, collections, etc.) since only the ledger effect
    // matters for this query's math.
    const now = Date.now();
    const journalId = await t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId,
        journalNumber: "TEST-0001",
        accountingDate: now,
        sourceType: "test",
        sourceId: "test-1",
        category: "SYSTEM",
        memo: "Test bank deposit",
        status: "POSTED",
        currency: "JOD",
        postedBy: userId,
        postedAt: now,
        createdAt: now,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId,
        journalEntryId: journalId,
        lineNumber: 1,
        accountId: bankAccountChart!._id,
        debitMinor: 200_000,
        creditMinor: 0,
        currency: "JOD",
        scale: 3,
        accountingDate: now,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId,
        journalEntryId: journalId,
        lineNumber: 2,
        accountId: retainedEarnings!._id,
        debitMinor: 0,
        creditMinor: 200_000,
        currency: "JOD",
        scale: 3,
        accountingDate: now,
      })
    );

    const balance = await asOwner.query(api.bankAccounts.getBookBalance, { orgId });
    expect(balance).not.toBeNull();
    expect(balance!.balanceMinor).toBe(1_200_000);
  });
});
