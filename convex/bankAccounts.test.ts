/**
 * Phase 41 tests — bank accounts.
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts. Bank starting balances come from the GL opening journal,
 * so these tests assert CRUD, single-reconciliation-target enforcement, and
 * the book-balance math against seeded ledger activity.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { BOOK_BALANCE_READ_BUDGET, computeBookBalance } from "./bankAccounts";
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
      openingBalanceMinor: 0,
      openingBalanceDate: Date.now(),
    });

    const accounts = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]._id).toBe(id);
    expect(accounts[0].isReconciliationTarget).toBe(false);
  });

  test("refuses a separate bank starting amount and leaves no bank row", async () => {
    const { orgId, asOwner } = await seedDealer();
    await expect(asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "Unposted bank seed", currency: "JOD",
      openingBalanceMinor: 1_000_000, openingBalanceDate: Date.now(),
    })).rejects.toThrow("BANK_OPENING_BALANCE_VIA_GL");
    expect(await asOwner.query(api.bankAccounts.list, { orgId })).toHaveLength(0);
  });

  test("refuses changing a bank's reference seed after creation", async () => {
    const { orgId, asOwner } = await seedDealer();
    const id = await asOwner.mutation(api.bankAccounts.create, {
      orgId, name: "Operating", currency: "JOD",
    });
    await expect(asOwner.mutation(api.bankAccounts.update, {
      orgId, bankAccountId: id, openingBalanceMinor: 500_000,
    })).rejects.toThrow("BANK_OPENING_BALANCE_VIA_GL");
    await expect(asOwner.mutation(api.bankAccounts.update, {
      orgId, bankAccountId: id, openingBalanceMinor: 0,
    })).rejects.toThrow("BANK_OPENING_BALANCE_VIA_GL");
    const [bank] = await asOwner.query(api.bankAccounts.list, { orgId });
    expect(bank.openingBalanceMinor).toBe(0);
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
      orgId, name: "Reference Only", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
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
    const id = await fx.asOwner.mutation(api.bankAccounts.create, {
      orgId: fx.orgId, name, currency, openingBalanceMinor: 0,
      openingBalanceDate: Date.now() - 30 * 24 * 60 * 60 * 1000, isReconciliationTarget: target,
    });
    // Simulate a historical reference seed: the new public mutation refuses it.
    await fx.t.run((ctx) => ctx.db.patch(id, { openingBalanceMinor: 1_000_000 }));
    return id;
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

  // SCRUM-54 (CodeRabbit Major): getBookBalance read every control-account line and
  // entry. One shared read budget now covers periods, snapshots, lines and entry
  // lookups; running out withholds the balance as BALANCE_HISTORY_INCOMPLETE.
  // convex-test enforces no Convex read limit, so these tests prove the budget
  // logic only, not platform behaviour.
  const asOfBalance = (fx: Fixture, asOf: number, budgetDocs: number) =>
    fx.t.run((ctx) => computeBookBalance(ctx, fx.orgId, asOf, budgetDocs));

  async function multiPeriodMultiBank(fx: Fixture) {
    const bankA = await createBank(fx, "Bank A", true);
    const bankB = await createBank(fx, "Bank B", false);
    await seedBankLine(fx, { debitMinor: 500_000, bankAccountId: bankA, period: "prior" });
    await seedBankLine(fx, { debitMinor: 300_000, bankAccountId: bankB, period: "prior" });
    await seedBankLine(fx, { debitMinor: 100_000, bankAccountId: bankA });
    await seedBankLine(fx, { creditMinor: 40_000, bankAccountId: bankB });
    return { bankA, bankB };
  }

  test("a small multi-period, multi-bank history keeps its correct balance under the default budget", async () => {
    const fx = await seedDealer();
    const { bankA } = await multiPeriodMultiBank(fx);

    const viaQuery = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(viaQuery).toMatchObject({ status: "OK", bankAccountId: bankA, balanceMinor: 600_000, unmatchedMinor: 0 });
    expect(await asOfBalance(fx, Date.now(), BOOK_BALANCE_READ_BUDGET)).toMatchObject({ status: "OK", balanceMinor: 600_000 });
  });

  test("multi-period, multi-bank history over the budget is withheld as incomplete, never OK", async () => {
    const fx = await seedDealer();
    await multiPeriodMultiBank(fx);

    const result = await asOfBalance(fx, Date.now(), 3);
    expect(result).toMatchObject({
      status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null, unmatchedMinor: null, unattributedLineCount: null,
    });
  });

  test("the budget is shared: entry lookups count even when the lines alone fit", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    for (let i = 0; i < 40; i++) await seedBankLine(fx, { debitMinor: 1_000, bankAccountId: bankA });

    // asOf is after every entry and none is later-dated, so the period is served from its
    // snapshot: no entry was read by the control, none is cached, and each of the 40 lines
    // needs its own charged entry lookup. Everything else costs at most 54 documents (40
    // lines plus banks, chart row, periods, the probe and at most 8 snapshot shards), so
    // only the lookups can push the total past 60.
    expect(await asOfBalance(fx, Date.now(), 60)).toMatchObject({ status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null });
    expect(await asOfBalance(fx, Date.now(), 200)).toMatchObject({ status: "OK", balanceMinor: 40_000 });
  });

  test("a partial period reads each entry once: the control's entry reads are not charged again by attribution", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const now = Date.now();
    const entries = 10;
    // No snapshots (so no random shard count) and one later-dated entry, which forces the
    // control to be measured from the period's entries rather than its snapshot.
    for (let i = 0; i < entries; i++) {
      await seedBankLine(fx, { debitMinor: 1_000, bankAccountId: bankA, accountingDate: now - 1_000 - i, snapshot: false });
    }
    await seedBankLine(fx, { debitMinor: 5_000, bankAccountId: bankA, accountingDate: now + 600_000, snapshot: false });

    // Fixed cost: bank, chart row, period, future-entry probe = 4. Then per counted entry:
    // the entry (control), its 2 lines (control) and its bank line (attribution) = 4, so
    // 4 + 4 * 10 = 44. Re-charging each entry for its status would need 4 + 5 * 10 = 54.
    expect(await asOfBalance(fx, now, 4 * entries)).toMatchObject({ status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null });
    expect(await asOfBalance(fx, now, 4 + 4 * entries + entries / 2)).toMatchObject({ status: "OK", balanceMinor: 10_000 });
  });

  test("duplicate control-account chart mappings spend the budget and keep the earliest active mapping", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    await seedBankLine(fx, { debitMinor: 100_000, bankAccountId: bankA });
    // Two newer rows with the control account's systemKey, as dirty legacy data can carry.
    const { bank } = await refs(fx);
    await fx.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = bank;
      void _id;
      void _creationTime;
      await ctx.db.insert("chartOfAccounts", { ...copy, name: "Duplicate bank 1" });
      await ctx.db.insert("chartOfAccounts", { ...copy, name: "Duplicate bank 2" });
    });

    // The earliest active row is still the one the lines were posted to.
    expect(await asOfBalance(fx, Date.now(), BOOK_BALANCE_READ_BUDGET)).toMatchObject({ status: "OK", balanceMinor: 100_000 });
  });

  test("an unbounded chart lookup cannot hide from the budget: three mappings exhaust a budget one mapping fits", async () => {
    const fx = await seedDealer();
    await createBank(fx, "Bank A", true);
    // No history: one bank + one chart row + one period + the future-entry probe = 4 documents.
    expect(await asOfBalance(fx, Date.now(), 4)).toMatchObject({ status: "OK", balanceMinor: 0 });

    const { bank } = await refs(fx);
    await fx.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = bank;
      void _id;
      void _creationTime;
      await ctx.db.insert("chartOfAccounts", { ...copy, name: "Duplicate bank 1" });
      await ctx.db.insert("chartOfAccounts", { ...copy, name: "Duplicate bank 2" });
    });
    // Three chart rows now cost 3, so the same history needs 6; 5 must be withheld, never OK.
    expect(await asOfBalance(fx, Date.now(), 5)).toMatchObject({ status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null });
    expect(await asOfBalance(fx, Date.now(), 6)).toMatchObject({ status: "OK", balanceMinor: 0 });
  });

  // Control for a partial period selects ENTRIES (period + entry date <= asOf) and then their
  // lines; attribution selects LINES by line date. Where the two disagree the balance is
  // withheld - never OK. A later-dated entry in the period forces that partial-period path.
  async function seedSplitDated(
    fx: Fixture,
    opts: {
      entryDate: number; lineDate: number; debitMinor?: number; creditMinor?: number;
      bankAccountId: Id<"bankAccounts">; entryPeriod?: "prior";
    }
  ) {
    const debitMinor = opts.debitMinor ?? 0;
    const creditMinor = opts.creditMinor ?? 0;
    const { bank, equity, current } = await refs(fx);
    const period = opts.entryPeriod === "prior" ? await priorPeriod(fx) : current;
    const tag = `${++seedSeq}`;
    await fx.t.run(async (ctx) => {
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId: fx.orgId, periodId: period._id, journalNumber: `T-${tag}`, accountingDate: opts.entryDate,
        sourceType: "test", sourceId: `test-${tag}`, category: "SYSTEM", memo: "split dated",
        status: "POSTED", currency: "JOD", postedBy: fx.userId, postedAt: opts.entryDate, createdAt: opts.entryDate,
      });
      const base = { orgId: fx.orgId, journalEntryId, currency: "JOD", scale: 3, accountingDate: opts.lineDate };
      await ctx.db.insert("journalLines", {
        ...base, lineNumber: 1, accountId: bank._id, debitMinor, creditMinor, bankAccountId: opts.bankAccountId,
      });
      await ctx.db.insert("journalLines", {
        ...base, lineNumber: 2, accountId: equity._id, debitMinor: creditMinor, creditMinor: debitMinor,
      });
    });
  }

  async function splitDatedBalance(
    entryOffsetMs: number,
    lineOffsetMs: number,
    entryPeriod?: "prior"
  ) {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const now = Date.now();
    await seedSplitDated(fx, {
      entryDate: now + entryOffsetMs, lineDate: now + lineOffsetMs, debitMinor: 50_000, bankAccountId: bankA, entryPeriod,
    });
    // A later-dated entry in the period: the period total cannot be used for this asOf.
    await seedBankLine(fx, { debitMinor: 1_000, bankAccountId: bankA, accountingDate: now + 600_000 });
    return await asOfBalance(fx, now, BOOK_BALANCE_READ_BUDGET);
  }

  test("a partial period whose entry and line dates agree is OK, measured from entries and their lines", async () => {
    expect(await splitDatedBalance(-30_000, -30_000)).toMatchObject({ status: "OK", balanceMinor: 50_000, unmatchedMinor: 0 });
  });

  // A line that disagrees with its entry's date or period is unverifiable, whatever the net.
  const HISTORY_UNVERIFIABLE = {
    status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null, unmatchedMinor: null, unattributedLineCount: null,
  };

  test("entry dated on or before asOf but its line dated after: control sees it, attribution does not -> withheld, not OK 0", async () => {
    expect(await splitDatedBalance(-30_000, 30_000)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("line dated on or before asOf but its entry dated after: attribution sees it, control does not -> withheld", async () => {
    expect(await splitDatedBalance(30_000, -30_000)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("a line dated in the containing period whose entry belongs to another period -> withheld", async () => {
    expect(await splitDatedBalance(-30_000, -30_000, "prior")).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("a line dated at or before asOf whose entry is dated later is withheld even when another entry cancels its net", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const bankB = await createBank(fx, "Bank B", false);
    const now = Date.now();
    // Attribution reads both lines (+50,000 / -50,000, net 0); the control reads neither entry.
    await seedSplitDated(fx, { entryDate: now + 30_000, lineDate: now - 30_000, debitMinor: 50_000, bankAccountId: bankA });
    await seedSplitDated(fx, { entryDate: now + 30_000, lineDate: now - 30_000, creditMinor: 50_000, bankAccountId: bankB });
    expect(await asOfBalance(fx, now, BOOK_BALANCE_READ_BUDGET)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("entries the control counts whose bank lines all post after asOf cannot net to a false OK 0 for the target bank", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const bankB = await createBank(fx, "Bank B", false);
    const now = Date.now();
    // Both entries are dated on or before asOf, so the entry-based control counts them (+50,000
    // and -50,000 = 0); both bank lines are dated after asOf, so attribution reads neither.
    // Control 0 == identified 0 with no unattributed line, yet bank A's posted receipt is +50,000.
    await seedSplitDated(fx, { entryDate: now - 30_000, lineDate: now + 30_000, debitMinor: 50_000, bankAccountId: bankA });
    await seedSplitDated(fx, { entryDate: now - 30_000, lineDate: now + 30_000, creditMinor: 50_000, bankAccountId: bankB });
    // A later-dated entry: the period total cannot be used, so the control comes from entries.
    await seedBankLine(fx, { debitMinor: 1_000, bankAccountId: bankA, accountingDate: now + 600_000 });

    // The two sources disagree about which lines are in scope, so the balance must be withheld.
    // Current code returns { status: "OK", balanceMinor: 0 } for bank A.
    expect(await asOfBalance(fx, now, BOOK_BALANCE_READ_BUDGET)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("a POSTED bank line whose entry has no periodId has no period to bound it -> withheld", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const { bank, equity } = await refs(fx);
    const now = Date.now();
    await fx.t.run(async (ctx) => {
      const date = now - 30_000;
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId: fx.orgId, journalNumber: "T-NOPERIOD", accountingDate: date, sourceType: "test", sourceId: "test-noperiod",
        category: "SYSTEM", memo: "no period", status: "POSTED", currency: "JOD", postedBy: fx.userId, postedAt: date, createdAt: date,
      });
      const base = { orgId: fx.orgId, journalEntryId, currency: "JOD", scale: 3, accountingDate: date };
      await ctx.db.insert("journalLines", {
        ...base, lineNumber: 1, accountId: bank._id, debitMinor: 50_000, creditMinor: 0, bankAccountId: bankA,
      });
      await ctx.db.insert("journalLines", { ...base, lineNumber: 2, accountId: equity._id, debitMinor: 0, creditMinor: 50_000 });
    });

    expect(await asOfBalance(fx, now, BOOK_BALANCE_READ_BUDGET)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("period bounds are inclusive: a line at the exact endDate is OK, one millisecond past it is withheld", async () => {
    const atEnd = await seedDealer();
    const bankAtEnd = await createBank(atEnd, "Bank A", true);
    const { endDate } = await priorPeriod(atEnd);
    await seedBankLine(atEnd, { debitMinor: 50_000, bankAccountId: bankAtEnd, period: "prior", accountingDate: endDate });
    expect(await asOfBalance(atEnd, Date.now(), BOOK_BALANCE_READ_BUDGET)).toMatchObject({ status: "OK", balanceMinor: 50_000 });

    const pastEnd = await seedDealer();
    const bankPastEnd = await createBank(pastEnd, "Bank A", true);
    const { endDate: pastEndDate } = await priorPeriod(pastEnd);
    await seedBankLine(pastEnd, { debitMinor: 50_000, bankAccountId: bankPastEnd, period: "prior", accountingDate: pastEndDate + 1 });
    expect(await asOfBalance(pastEnd, Date.now(), BOOK_BALANCE_READ_BUDGET)).toMatchObject(HISTORY_UNVERIFIABLE);
  });

  test("a mid-period asOf is exact within the budget and withheld, not guessed, beyond it", async () => {
    const fx = await seedDealer();
    const bankA = await createBank(fx, "Bank A", true);
    const now = Date.now();
    await seedBankLine(fx, { debitMinor: 500_000, bankAccountId: bankA, period: "prior" });
    await seedBankLine(fx, { debitMinor: 200_000, bankAccountId: bankA, accountingDate: now - 60_000 });
    await seedBankLine(fx, { debitMinor: 50_000, bankAccountId: bankA, accountingDate: now + 60_000 });

    // The period snapshot already holds the later entry, so a mid-period asOf must be
    // measured from lines; it must not read the period total.
    expect(await asOfBalance(fx, now, BOOK_BALANCE_READ_BUDGET)).toMatchObject({ status: "OK", balanceMinor: 700_000 });
    expect(await asOfBalance(fx, now, 3)).toMatchObject({ status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null });
  });
});
