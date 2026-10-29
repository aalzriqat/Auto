/**
 * SCRUM-858 S5 (owner ruling SCRUM-858#c23884, 2026-10-29): cash and each individual bank account open as their own
 * balance, each bank's opening reconciles to its GL bank account, and any difference the dealer cannot explain is
 * REPORTED under the owner's label. It is never posted, never forced to balance and never changes a balance.
 *
 * The read under test is `bankAccounts.openingReconciliation`. Every test drives public handlers on the convex-test
 * harness: serial, no OCC, so these prove logic, not production concurrency.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { resetOrgToCompletion } from "../test-utils/orgResetFixtures";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const OWNER_LABEL = {
  en: "Unexplained opening-balance reconciliation difference",
  ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة",
};

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Opening bank org", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() }),
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "ob_owner", email: "ob_owner@test.com", name: "Owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      isSystemOwnerRole: true,
      permissions: ["manage:finance", "view:finance", "view:reports"],
    }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const owner = t.withIdentity({ subject: "ob_owner", clerkId: "ob_owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const accountId = (key: string) => {
    const found = accounts.find((row) => row.systemKey === key);
    if (!found) throw new Error(`Missing system account ${key}`);
    return found._id;
  };
  return { t, orgId, userId, owner, accountId, periodId: period._id };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function bank(s: Seed, name: string, referenceMinor: number, target = false) {
  return s.owner.mutation(api.bankAccounts.create, {
    orgId: s.orgId,
    name,
    currency: "JOD",
    openingBalanceMinor: referenceMinor,
    openingBalanceDate: Date.now(),
    isReconciliationTarget: target,
  });
}

/** Opens cash plus two banks. The postings are 4,000.000 and 3,000.000 JOD and 1,000.000 JOD of cash. */
async function openTwoBanks(s: Seed, bankA: Id<"bankAccounts">, bankB: Id<"bankAccounts">) {
  return s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId: s.orgId,
    expectedCurrency: "JOD",
    asOfDate: Date.now(),
    lines: [
      { accountId: s.accountId("BANK_ACCOUNT"), debitMinor: 4_000_000, creditMinor: 0, bankAccountId: bankA },
      { accountId: s.accountId("BANK_ACCOUNT"), debitMinor: 3_000_000, creditMinor: 0, bankAccountId: bankB },
      { accountId: s.accountId("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
    ],
  });
}

async function writeCounts(s: Seed) {
  return s.t.run(async (ctx) => ({
    journals: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
  }));
}

/** A later bank receipt, seeded as a posted journal against one physical bank. */
async function laterReceipt(s: Seed, bankAccountId: Id<"bankAccounts">, amountMinor: number) {
  await s.t.run(async (ctx) => {
    const period = await ctx.db.get(s.periodId);
    if (!period) throw new Error("Missing period");
    const accountingDate = Date.now();
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId,
      periodId: period._id,
      journalNumber: `OB-LATER-${amountMinor}`,
      accountingDate,
      sourceType: "test",
      sourceId: `ob-later-${amountMinor}`,
      category: "SYSTEM",
      memo: "later bank receipt",
      status: "POSTED",
      currency: "JOD",
      postedBy: s.userId,
      postedAt: accountingDate,
      createdAt: accountingDate,
    });
    const base = { orgId: s.orgId, journalEntryId, currency: "JOD", scale: 3, accountingDate };
    await ctx.db.insert("journalLines", {
      ...base,
      lineNumber: 1,
      accountId: s.accountId("BANK_ACCOUNT"),
      debitMinor: amountMinor,
      creditMinor: 0,
      bankAccountId,
    });
    await ctx.db.insert("journalLines", {
      ...base,
      lineNumber: 2,
      accountId: s.accountId("RETAINED_EARNINGS"),
      debitMinor: 0,
      creditMinor: amountMinor,
    });
    await incrementAccountSnapshot(ctx, {
      orgId: s.orgId,
      accountId: s.accountId("BANK_ACCOUNT"),
      currency: "JOD",
      periodId: period._id,
      debitMinor: amountMinor,
      creditMinor: 0,
    });
  });
}

describe("SCRUM-858 S5 per-bank opening reconciliation", () => {
  test("two banks with distinct openings each reconcile to their own posted line and to the bank control, with no difference", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation.status).toBe("OK");
    expect(reconciliation.currency).toBe("JOD");
    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(bankA)).toMatchObject({ openingLineMinor: 4_000_000, referenceOpeningMinor: 4_000_000, differenceMinor: 0 });
    expect(byId.get(bankB)).toMatchObject({ openingLineMinor: 3_000_000, referenceOpeningMinor: 3_000_000, differenceMinor: 0 });
    // G-1: the per-bank lines add up to the BANK_ACCOUNT control's opening debit, and nothing is unattributed.
    expect(reconciliation.bankLinesTotalMinor).toBe(7_000_000);
    expect(reconciliation.controlOpeningMinor).toBe(7_000_000);
    expect(reconciliation.unattributedOpeningMinor).toBe(0);
    expect(reconciliation.unexplainedOpeningDifference).toBeNull();

    // Each bank's own book balance equals its own line.
    expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({
      status: "OK", bankAccountId: bankA, balanceMinor: 4_000_000,
    });
    await s.owner.mutation(api.bankAccounts.setReconciliationTarget, { orgId: s.orgId, bankAccountId: bankB });
    expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({
      status: "OK", bankAccountId: bankB, balanceMinor: 3_000_000,
    });
  });

  test("a bank reference balance that differs from its posted line is reported under the owner's label and nothing is posted or changed", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_100_000, true); // statement says 4,100.000; the opening posts 4,000.000
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    const before = await writeCounts(s);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(bankA)).toMatchObject({ openingLineMinor: 4_000_000, referenceOpeningMinor: 4_100_000, differenceMinor: 100_000 });
    expect(byId.get(bankB)).toMatchObject({ differenceMinor: 0 });
    expect(reconciliation.unexplainedOpeningDifference).toEqual({
      label: OWNER_LABEL,
      currencies: [{ currency: "JOD", differenceMinor: 100_000, absoluteDifferenceMinor: 100_000 }],
    });
    // The report is read-only: no journal, line, event or transaction appeared, and the balance is still the posted line.
    expect(await writeCounts(s)).toEqual(before);
    expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({
      status: "OK", bankAccountId: bankA, balanceMinor: 4_000_000,
    });
  });

  test("a bank with a stated opening balance but no posted opening line reports the whole amount as the difference", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    const bankC = await bank(s, "Bank C", 250_000); // never named in the opening
    await openTwoBanks(s, bankA, bankB);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(bankC)).toMatchObject({ openingLineMinor: 0, referenceOpeningMinor: 250_000, differenceMinor: 250_000 });
    expect(reconciliation.unexplainedOpeningDifference?.currencies).toEqual([
      { currency: "JOD", differenceMinor: 250_000, absoluteDifferenceMinor: 250_000 },
    ]);
  });

  test("a difference in the other direction is reported with its sign, and differences of one currency net per currency", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 3_900_000, true); // 100.000 below the posted line
    const bankB = await bank(s, "Bank B", 3_030_000); // 30.000 above the posted line
    await openTwoBanks(s, bankA, bankB);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(bankA)?.differenceMinor).toBe(-100_000);
    expect(byId.get(bankB)?.differenceMinor).toBe(30_000);
    expect(reconciliation.unexplainedOpeningDifference?.currencies).toEqual([
      { currency: "JOD", differenceMinor: -70_000, absoluteDifferenceMinor: 130_000 },
    ]);
  });

  test("two offsetting bank differences still raise the report: the net is zero but the absolute difference is not", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_100_000, true); // +100.000
    const bankB = await bank(s, "Bank B", 2_900_000); // -100.000
    await openTwoBanks(s, bankA, bankB);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation.unexplainedOpeningDifference?.currencies).toEqual([
      { currency: "JOD", differenceMinor: 0, absoluteDifferenceMinor: 200_000 },
    ]);
  });

  test("an opening bank line that names no bank is shown as unattributed and its bank reports the difference", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    // Pre-identity history: drop the bank name from Bank B's opening line.
    await s.t.runUnwrapped(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      const line = lines.find((row) => row.bankAccountId === bankB);
      if (!line) throw new Error("Missing Bank B opening line");
      await ctx.db.patch(line._id, { bankAccountId: undefined });
    });

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation).toMatchObject({
      status: "OK",
      controlOpeningMinor: 7_000_000,
      bankLinesTotalMinor: 4_000_000,
      unattributedOpeningMinor: 3_000_000,
    });
    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(bankB)).toMatchObject({ openingLineMinor: 0, referenceOpeningMinor: 3_000_000, differenceMinor: 3_000_000 });
    expect(reconciliation.unexplainedOpeningDifference).not.toBeNull();
  });

  test("a bank deactivated after the opening keeps its opening line in the reconciliation", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    await s.owner.mutation(api.bankAccounts.deactivate, { orgId: s.orgId, bankAccountId: bankB });

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation.banks.map((row) => row.bankAccountId).sort()).toEqual([bankA, bankB].sort());
    expect(reconciliation.bankLinesTotalMinor).toBe(7_000_000);
  });

  test("a bank in another currency than the opening is listed but never compared", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    const usdBank = await s.owner.mutation(api.bankAccounts.create, {
      orgId: s.orgId, name: "Dollar bank", currency: "USD", openingBalanceMinor: 99_999, openingBalanceDate: Date.now(),
    });

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    const byId = new Map(reconciliation.banks.map((row) => [row.bankAccountId, row]));
    expect(byId.get(usdBank)).toMatchObject({ currency: "USD", referenceOpeningMinor: 99_999, differenceMinor: null });
    expect(reconciliation.unexplainedOpeningDifference).toBeNull();
  });

  test("a later receipt on one bank moves only that bank's book balance and leaves the opening reconciliation unchanged", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    const openingBefore = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    await laterReceipt(s, bankA, 250_000);

    expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({
      status: "OK", bankAccountId: bankA, balanceMinor: 4_250_000,
    });
    await s.owner.mutation(api.bankAccounts.setReconciliationTarget, { orgId: s.orgId, bankAccountId: bankB });
    expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({
      status: "OK", bankAccountId: bankB, balanceMinor: 3_000_000,
    });
    expect(await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId })).toEqual(openingBefore);
  });

  test("with no opening posted the banks are listed with their reference balances and no difference is claimed", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation.status).toBe("NO_OPENING");
    expect(reconciliation.banks).toMatchObject([{ bankAccountId: bankA, openingLineMinor: null, referenceOpeningMinor: 4_000_000, differenceMinor: null }]);
    expect(reconciliation.unexplainedOpeningDifference).toBeNull();
  });

  test("after a financial reset the retained opening header is not read as a current opening", async () => {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    await s.t.run((ctx) => ctx.db.patch(s.orgId, { suspended: true }));
    await resetOrgToCompletion(s.t, s.orgId, 50);
    await s.t.run((ctx) => ctx.db.patch(s.orgId, { suspended: false }));

    const reconciliation = await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

    expect(reconciliation.status).toBe("NO_OPENING");
    expect(reconciliation.unexplainedOpeningDifference).toBeNull();
  });

  test("another organization's owner cannot read it", async () => {
    const s = await seed();
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
    const intruderId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "ob_intruder", email: "ob_intruder@test.com", name: "Intruder" }));
    const intruderRole = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Owner", isSystemOwnerRole: true, permissions: ["manage:finance", "view:finance"] }),
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: intruderId, roleId: intruderRole }));
    const intruder = s.t.withIdentity({ subject: "ob_intruder", clerkId: "ob_intruder" });

    await expect(intruder.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId })).rejects.toThrow();
  });

  test("a user of the same organization without view:finance cannot read it", async () => {
    const s = await seed();
    const clerkId = "ob_sales";
    const salesId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId, email: "ob_sales@test.com", name: "Sales" }));
    const salesRole = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Sales", permissions: ["view:vehicles"] }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: salesId, roleId: salesRole }));
    const sales = s.t.withIdentity({ subject: clerkId, clerkId });

    await expect(sales.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId })).rejects.toThrow();
    // The owner of the same organization still reads it, so the refusal is the permission and not a broken setup.
    expect((await s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId })).status).toBe("NO_OPENING");
  });
});

describe("SCRUM-858 S5 the report refuses figures it cannot prove", () => {
  async function manyBanks(s: Seed, count: number) {
    for (let index = 0; index < count; index++) {
      await s.t.run((ctx) =>
        ctx.db.insert("bankAccounts", {
          orgId: s.orgId, name: `Extra bank ${index}`, currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
          isActive: true, isReconciliationTarget: false, createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
        }),
      );
    }
  }

  async function openingJournal(s: Seed) {
    return s.t.runUnwrapped(async (ctx) => {
      const rows = await ctx.db
        .query("journalEntries")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "cutover").eq("sourceId", String(s.orgId)))
        .take(5);
      const journal = rows.find((row) => row.category === "OPENING_BALANCE");
      if (!journal) throw new Error("Missing opening journal");
      return journal;
    });
  }

  async function padOpeningLines(s: Seed, extra: number) {
    const journal = await openingJournal(s);
    await s.t.runUnwrapped(async (ctx) => {
      for (let index = 0; index < extra; index++) {
        await ctx.db.insert("journalLines", {
          orgId: s.orgId, journalEntryId: journal._id, currency: "JOD", scale: 3, accountingDate: journal.accountingDate,
          lineNumber: 100 + index, accountId: s.accountId("CASH_ON_HAND"), debitMinor: 0, creditMinor: 0,
        });
      }
    });
  }

  async function openedBanks() {
    const s = await seed();
    const bankA = await bank(s, "Bank A", 4_000_000, true);
    const bankB = await bank(s, "Bank B", 3_000_000);
    await openTwoBanks(s, bankA, bankB);
    return { s, bankA, bankB };
  }

  const report = (s: Seed) => s.owner.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });

  test("more than two hundred banks report the opening as unavailable rather than a partial reconciliation", async () => {
    const { s } = await openedBanks();
    await manyBanks(s, 199); // 201 banks in all

    const result = await report(s);

    expect(result.status).toBe("OPENING_PROOF_UNAVAILABLE");
    expect(result.unexplainedOpeningDifference).toBeNull();
    expect(result.banks.length).toBeLessThanOrEqual(200);
    expect(result.banks.every((row) => row.openingLineMinor === null && row.differenceMinor === null)).toBe(true);
  });

  test("exactly two hundred banks still reconcile", async () => {
    const { s } = await openedBanks();
    await manyBanks(s, 198);

    const result = await report(s);

    expect(result.status).toBe("OK");
    expect(result.banks).toHaveLength(200);
  });

  test("an opening journal with more than five hundred lines reports the opening as unavailable", async () => {
    const { s } = await openedBanks();
    await padOpeningLines(s, 497); // 4 + 497 = 501 lines

    expect((await report(s)).status).toBe("OPENING_PROOF_UNAVAILABLE");
  });

  test("exactly five hundred opening lines still reconcile", async () => {
    const { s } = await openedBanks();
    await padOpeningLines(s, 496); // 4 + 496 = 500 lines

    expect((await report(s)).status).toBe("OK");
  });

  test("two live opening journals make the opening unavailable, never a guess", async () => {
    const { s, bankA } = await openedBanks();
    const journal = await openingJournal(s);
    await s.t.runUnwrapped(async (ctx) => {
      const { _id, _creationTime, ...rest } = journal;
      void _id;
      void _creationTime;
      await ctx.db.insert("journalEntries", { ...rest, journalNumber: `${journal.journalNumber}-DUP` });
    });

    const result = await report(s);

    expect(result.status).toBe("OPENING_PROOF_UNAVAILABLE");
    expect(result.banks.find((row) => row.bankAccountId === bankA)?.openingLineMinor).toBeNull();
  });

  test("an opening journal that names no currency is unavailable", async () => {
    const { s } = await openedBanks();
    const journal = await openingJournal(s);
    await s.t.runUnwrapped((ctx) => ctx.db.patch(journal._id, { currency: undefined }));

    expect((await report(s)).status).toBe("OPENING_PROOF_UNAVAILABLE");

    // With no bank line in the opening, the journal's own currency is the only thing that can refuse.
    const cashOnly = await seed();
    await bank(cashOnly, "Bank A", 4_000_000, true);
    await cashOnly.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: cashOnly.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: cashOnly.accountId("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
        { accountId: cashOnly.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000_000 },
      ],
    });
    expect((await report(cashOnly)).status).toBe("OK");
    const cashJournal = await openingJournal(cashOnly);
    // A legacy header that names no currency either, so the source identity itself still resolves.
    await cashOnly.t.runUnwrapped(async (ctx) => {
      await ctx.db.patch(cashJournal._id, { currency: undefined });
      const headers = await ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", (q) => q.eq("orgId", cashOnly.orgId).eq("status", "POSTED")).take(5);
      for (const header of headers) await ctx.db.patch(header._id, { currency: undefined });
    });
    expect((await report(cashOnly)).status).toBe("OPENING_PROOF_UNAVAILABLE");
  });

  test("an opening bank line in a different currency or organization than its journal makes the opening unavailable", async () => {
    for (const field of ["currency", "org"] as const) {
      const { s, bankB } = await openedBanks();
      const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: `Other ${field}`, createdAt: Date.now() }));
      await s.t.runUnwrapped(async (ctx) => {
        const lines = await ctx.db.query("journalLines").collect();
        const line = lines.find((row) => row.bankAccountId === bankB);
        if (!line) throw new Error("Missing Bank B opening line");
        await ctx.db.patch(line._id, field === "currency" ? { currency: "USD" } : { orgId: otherOrgId });
      });

      expect((await report(s)).status, field).toBe("OPENING_PROOF_UNAVAILABLE");
    }
  });

  test("a bank-control line on an account of another organization is not read as this organization's bank line", async () => {
    const { s, bankB } = await openedBanks();
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other chart", createdAt: Date.now() }));
    await s.t.runUnwrapped(async (ctx) => {
      const control = await ctx.db.get(s.accountId("BANK_ACCOUNT"));
      if (!control) throw new Error("Missing bank control");
      const { _id, _creationTime, ...rest } = control;
      void _id;
      void _creationTime;
      const foreignAccountId = await ctx.db.insert("chartOfAccounts", { ...rest, orgId: otherOrgId });
      const lines = await ctx.db.query("journalLines").collect();
      const line = lines.find((row) => row.bankAccountId === bankB);
      if (!line) throw new Error("Missing Bank B opening line");
      await ctx.db.patch(line._id, { accountId: foreignAccountId });
    });

    const result = await report(s);

    expect(result.controlOpeningMinor).toBe(4_000_000);
    expect(result.banks.find((row) => row.bankAccountId === bankB)).toMatchObject({ openingLineMinor: 0, differenceMinor: 3_000_000 });
  });

  test("bank amounts too large to add exactly make the opening unavailable", async () => {
    const { s } = await openedBanks();
    await s.t.runUnwrapped(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      for (const line of lines.filter((row) => row.bankAccountId !== undefined)) {
        await ctx.db.patch(line._id, { debitMinor: Number.MAX_SAFE_INTEGER });
      }
    });

    expect((await report(s)).status).toBe("OPENING_PROOF_UNAVAILABLE");
  });

  test("a deleted bank that holds no opening line is not listed", async () => {
    const { s, bankA, bankB } = await openedBanks();
    const bankC = await bank(s, "Bank C", 0);
    await s.t.run((ctx) => ctx.db.patch(bankC, { isDeleted: true }));

    const result = await report(s);

    expect(result.banks.map((row) => row.bankAccountId).sort()).toEqual([bankA, bankB].sort());
  });
});
