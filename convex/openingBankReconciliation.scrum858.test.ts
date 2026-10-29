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
});
