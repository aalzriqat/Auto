/**
 * Phase 41 tests — bank accounts.
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts. Opening balance is a reporting-layer number (no journal entry),
 * so these tests assert CRUD, single-reconciliation-target enforcement, and
 * the book-balance math against seeded ledger activity.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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

  // SCRUM-54: the GL is the sole authority for a bank's book balance.
  // openingBalanceMinor is reference metadata and is never added on top.
  type Fixture = Awaited<ReturnType<typeof seedDealer>>;
  type EntryStatus = "DRAFT" | "VALIDATED" | "POSTED" | "REVERSED";

  // Chart rows and periods are looked up once per fixture, not per seeded line.
  type FixtureRefs = {
    bank: Doc<"chartOfAccounts">;
    equity: Doc<"chartOfAccounts">;
    current: Doc<"accountingPeriods">;
    prior?: Doc<"accountingPeriods">;
  };
  const refsByFixture = new WeakMap<Fixture, FixtureRefs>();
  async function refs(fx: Fixture): Promise<FixtureRefs> {
    const cached = refsByFixture.get(fx);
    if (cached) return cached;
    const chart = async (systemKey: string) =>
      (await fx.t.run((ctx) =>
        ctx.db
          .query("chartOfAccounts")
          .withIndex("by_org_systemKey", (q) => q.eq("orgId", fx.orgId).eq("systemKey", systemKey))
          .unique()
      ))!;
    const current = (await fx.asOwner.query(api.accountingPeriods.list, { orgId: fx.orgId }))[0];
    const made = { bank: await chart("BANK_ACCOUNT"), equity: await chart("RETAINED_EARNINGS"), current };
    refsByFixture.set(fx, made);
    return made;
  }
  // A fully elapsed (closed-out) prior-year period, whose balance the
  // consumer must read from snapshots.
  async function priorPeriod(fx: Fixture) {
    const r = await refs(fx);
    if (r.prior) return r.prior;
    const year = new Date().getUTCFullYear() - 1;
    await fx.asOwner.mutation(api.accountingPeriods.create, {
      orgId: fx.orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year, periodNumber: 1,
    });
    r.prior = (await fx.asOwner.query(api.accountingPeriods.list, { orgId: fx.orgId })).find((p) => p.fiscalYear === year)!;
    return r.prior;
  }

  // Monotonic, so entries seeded in the same millisecond never collide.
  let seedSeq = 0;
  async function seedBankLine(
    fx: Fixture,
    opts: {
      debitMinor?: number;
      creditMinor?: number;
      bankAccountId?: Id<"bankAccounts">;
      status?: EntryStatus;
      currency?: string;
      accountingDate?: number;
      period?: "current" | "prior";
      reversalOfEntryId?: Id<"journalEntries">;
      /** Posting paths update the period snapshot; DRAFT/VALIDATED entries do not. */
      snapshot?: boolean;
    }
  ) {
    const debitMinor = opts.debitMinor ?? 0;
    const creditMinor = opts.creditMinor ?? 0;
    const status = opts.status ?? "POSTED";
    const currency = opts.currency ?? "JOD";
    const { bank, equity, current } = await refs(fx);
    const period = opts.period === "prior" ? await priorPeriod(fx) : current;
    const accountingDate = opts.accountingDate ?? (opts.period === "prior" ? period.startDate + 86_400_000 : Date.now());
    const tag = `${++seedSeq}`;
    return await fx.t.run(async (ctx) => {
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId: fx.orgId, periodId: period._id, journalNumber: `T-${tag}`, accountingDate,
        sourceType: "test", sourceId: `test-${tag}`,
        category: opts.reversalOfEntryId ? "REVERSAL" : "SYSTEM", memo: "bank line",
        status, currency, postedBy: fx.userId, postedAt: accountingDate, createdAt: accountingDate,
        ...(opts.reversalOfEntryId ? { reversalOfJournalEntryId: opts.reversalOfEntryId } : {}),
      });
      const base = { orgId: fx.orgId, journalEntryId, currency, scale: 3, accountingDate };
      await ctx.db.insert("journalLines", {
        ...base, lineNumber: 1, accountId: bank._id, debitMinor, creditMinor,
        ...(opts.bankAccountId ? { bankAccountId: opts.bankAccountId } : {}),
      });
      await ctx.db.insert("journalLines", {
        ...base, lineNumber: 2, accountId: equity._id, debitMinor: creditMinor, creditMinor: debitMinor,
      });
      if (opts.snapshot ?? (status === "POSTED" || status === "REVERSED")) {
        await incrementAccountSnapshot(ctx, {
          orgId: fx.orgId, accountId: bank._id, currency, periodId: period._id, debitMinor, creditMinor,
        });
      }
      return journalEntryId;
    });
  }

  async function createBank(fx: Fixture, name: string, target: boolean, currency = "JOD") {
    return await fx.asOwner.mutation(api.bankAccounts.create, {
      orgId: fx.orgId, name, currency, openingBalanceMinor: 1_000_000,
      openingBalanceDate: Date.now() - 30 * 24 * 60 * 60 * 1000, isReconciliationTarget: target,
    });
  }

  test("control: an attributable GL amount is the balance and reference openingBalanceMinor is not added", async () => {
    const fx = await seedDealer();
    const bankId = await createBank(fx, "Operating", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankId });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "OK", bankAccountId: bankId, balanceMinor: 200_000, unmatchedMinor: 0, unattributedLineCount: 0,
    });
  });

  test("an opening balance already posted to the GL is not double counted", async () => {
    const fx = await seedDealer();
    const bankId = await createBank(fx, "Operating", true); // reference metadata 1,000,000
    await seedBankLine(fx, { debitMinor: 1_000_000, bankAccountId: bankId }); // posted GL opening

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 1_000_000 });
  });

  test("same-currency banks: unattributed control activity fails closed instead of landing on the target", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await createBank(fx, "Bank B", false);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 70_000 }); // legacy line, identity absent

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY", bankAccountId: bankA, balanceMinor: null, unmatchedMinor: 70_000,
      unattributedLineCount: 1,
    });
  });

  test("equal-and-opposite legacy lines with no bank identity do not net to a false OK", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 100 });
    await seedBankLine(fx, { creditMinor: 100 });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: 0, unattributedLineCount: 2,
    });
  });

  test("equal-and-opposite lines naming another organization's bank fail closed", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const foreignBank = await fx.t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      return await ctx.db.insert("bankAccounts", {
        orgId: otherOrg, name: "Foreign", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
        isActive: true, isReconciliationTarget: false, createdBy: fx.userId, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 50, bankAccountId: foreignBank });
    await seedBankLine(fx, { creditMinor: 50, bankAccountId: foreignBank });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: 0, unattributedLineCount: 2,
    });
  });

  test("same-currency banks: activity attributed to another bank is not this bank's balance", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const bankB = await createBank(fx, "Bank B", false);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 90_000, bankAccountId: bankB });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", bankAccountId: bankA, balanceMinor: 200_000 });
  });

  test("a snapshot control total that line attribution cannot explain fails closed", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    // The control account moved in the period snapshot with no journal line behind it.
    const { bank, current } = await refs(fx);
    await fx.t.run((ctx) =>
      incrementAccountSnapshot(ctx, {
        orgId: fx.orgId, accountId: bank._id, currency: "JOD", periodId: current._id, debitMinor: 40_000, creditMinor: 0,
      })
    );

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: 40_000 });
  });

  test("history stamped to a deactivated same-org bank still counts as identified", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const oldBank = await createBank(fx, "Closed Bank", false);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 60_000, bankAccountId: oldBank });
    await fx.asOwner.mutation(api.bankAccounts.deactivate, { orgId: fx.orgId, bankAccountId: oldBank });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 200_000, unattributedLineCount: 0 });
  });

  test("closed-period activity is read from snapshots and agrees with its stamped lines", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 500_000, bankAccountId: bankA, period: "prior" });
    await seedBankLine(fx, { creditMinor: 120_000, bankAccountId: bankA });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 380_000 });
  });

  test("a closed-period snapshot with no stamped line behind it fails closed", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 500_000, bankAccountId: bankA, period: "prior" });
    const { bank } = await refs(fx);
    const prior = await priorPeriod(fx);
    await fx.t.run((ctx) =>
      incrementAccountSnapshot(ctx, {
        orgId: fx.orgId, accountId: bank._id, currency: "JOD", periodId: prior._id, debitMinor: 25_000, creditMinor: 0,
      })
    );

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: 25_000 });
  });

  test("a stamped REVERSED original and its stamped reversing entry both count and cancel", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    const original = await seedBankLine(fx, { debitMinor: 300_000, bankAccountId: bankA, status: "REVERSED" });
    await seedBankLine(fx, { creditMinor: 300_000, bankAccountId: bankA, reversalOfEntryId: original });

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 200_000, unattributedLineCount: 0 });
  });

  test("an unstamped reversal of a stamped original is not accepted", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const original = await seedBankLine(fx, { debitMinor: 300_000, bankAccountId: bankA, status: "REVERSED" });
    await seedBankLine(fx, { creditMinor: 300_000, reversalOfEntryId: original }); // no bank identity

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: -300_000, unattributedLineCount: 1,
    });
  });

  test("a JOD control line naming a same-org USD bank is invalid attribution and fails closed", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const usdBank = await createBank(fx, "USD Bank", false, "USD");
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 50_000, bankAccountId: usdBank }); // JOD line, USD bank

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({
      status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null, unmatchedMinor: 50_000, unattributedLineCount: 1,
    });
  });

  test("DRAFT entries are not ledger activity", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 50_000, bankAccountId: bankA, status: "DRAFT" });
    await seedBankLine(fx, { debitMinor: 7_000, status: "DRAFT" }); // unstamped draft is ignored too

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 200_000, unattributedLineCount: 0 });
  });

  test("activity in another currency does not enter the target's balance", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA });
    await seedBankLine(fx, { debitMinor: 80_000, currency: "USD" }); // unstamped, other currency

    const balance = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(balance).toMatchObject({ status: "OK", balanceMinor: 200_000, unattributedLineCount: 0 });
  });

  test("lines dated after asOf are excluded, and included once asOf reaches them", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const now = Date.now();
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA, accountingDate: now - 60_000 });
    await seedBankLine(fx, { debitMinor: 50_000, bankAccountId: bankA, accountingDate: now + 60_000 });

    const before = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: now });
    expect(before).toMatchObject({ status: "OK", balanceMinor: 200_000 });
    const after = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId, asOf: now + 120_000 });
    expect(after).toMatchObject({ status: "OK", balanceMinor: 250_000 });
  });
});
