/**
 * SCRUM-54 — an opening balance posted to the BANK_ACCOUNT control account
 * must name the physical bank it seeds.
 *
 * `getBookBalance` withholds the balance for any bank-control line without a
 * same-org, same-currency `bankAccountId`, so an opening line without one would
 * leave the org permanently unattributed. The identity is captured at the user
 * mutation boundary (never defaulted, never inferred by amount or date),
 * preserved through approval, and stamped on the posted journal line.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

// Retained earnings is a synthetic test offset only; it classifies no real guide amount.
async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "OB Bank Dealer", createdAt: Date.now() })
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
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  const accountantRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Accountant",
      permissions: ["view:finance", "manage:finance"],
    })
  );
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "obb_owner", email: "obb_owner@example.com", name: "Owner" })
  );
  const accountantId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "obb_acct", email: "obb_acct@example.com", name: "Accountant" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: accountantId, roleId: accountantRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asOwner = t.withIdentity({ subject: "obb_owner", clerkId: "obb_owner" });
  const asAccountant = t.withIdentity({ subject: "obb_acct", clerkId: "obb_acct" });

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
  const bankControlId = byKey("BANK_ACCOUNT");
  const syntheticOffsetId = byKey("RETAINED_EARNINGS");
  const cashId = byKey("CASH_ON_HAND");

  const createBank = (name: string, currency = "JOD", isReconciliationTarget = false) =>
    asOwner.mutation(api.bankAccounts.create, {
      orgId,
      name,
      currency,
      openingBalanceMinor: 0,
      openingBalanceDate: Date.now(),
      isReconciliationTarget,
    });

  return { t, orgId, ownerId, asOwner, asAccountant, bankControlId, syntheticOffsetId, cashId, createBank };
}

type Fx = Awaited<ReturnType<typeof seed>>;

function bankOpening(fx: Fx, bankAccountId?: Id<"bankAccounts">, amount = 1_000_000) {
  return {
    orgId: fx.orgId,
    expectedCurrency: "JOD",
    asOfDate: Date.now(),
    lines: [
      { accountId: fx.bankControlId, debitMinor: amount, creditMinor: 0, ...(bankAccountId ? { bankAccountId } : {}) },
      { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: amount },
    ],
  };
}

async function sideEffects(fx: Fx) {
  return fx.t.run(async (ctx) => ({
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
    entries: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    snapshots: (await ctx.db.query("accountBalanceSnapshots").collect()).length,
  }));
}

async function postedLines(fx: Fx, journalId: Id<"journalEntries"> | string) {
  return fx.t.run((ctx) =>
    ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId as Id<"journalEntries">))
      .collect()
  );
}

const NO_SIDE_EFFECTS = { drafts: 0, entries: 0, lines: 0, snapshots: 0 };

test("records one attributed transfer and uses the same identities when reversing it", async () => {
  const fx = await seed();
  const fromBankAccountId = await fx.createBank("Funding bank", "JOD", true);
  await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx, fromBankAccountId));
  const toBankAccountId = await fx.createBank("Newly funded bank");
  const command = {
    orgId: fx.orgId, currency: "JOD", fromBankAccountId, toBankAccountId, amountMinor: 126_400,
    accountingDate: Date.now(), reference: "Confirmed transfer reference", idempotencyKey: "internal-transfer",
  };
  const moved = await fx.asOwner.mutation(api.bankTransfers.record, command);
  await expect(fx.asOwner.mutation(api.bankTransfers.record, command)).resolves.toEqual(moved);
  await expect(fx.asOwner.mutation(api.bankTransfers.record, { ...command, amountMinor: 126_401 })).rejects.toThrow();
  expect((await postedLines(fx, moved.journalEntryId)).map(line => [line.bankAccountId, line.debitMinor, line.creditMinor]))
    .toEqual([[toBankAccountId, 126_400, 0], [fromBankAccountId, 0, 126_400]]);
  const balances = async () => {
    const figures = await fx.asOwner.query(api.bankAccounts.listBookBalances, { orgId: fx.orgId });
    return new Map(figures.map(row => [row.bankAccountId, row.balanceMinor]));
  };
  expect(await balances()).toEqual(new Map([[fromBankAccountId, 873_600], [toBankAccountId, 126_400]]));

  const reverse = { orgId: fx.orgId, eventId: moved.eventId, accountingDate: Date.now(),
    reason: "Reverse the incorrect confirmed transfer", idempotencyKey: "internal-transfer-reversal" };
  const outgoing = (await postedLines(fx, moved.journalEntryId)).find(line => line.creditMinor === 126_400);
  if (!outgoing) throw new Error("Expected the outgoing bank line");
  const statementLineId = await fx.t.run(ctx => ctx.db.insert("bankStatementLines", {
    orgId: fx.orgId, bankAccountId: fromBankAccountId, importBatchId: "transfer-statement",
    statementDate: command.accountingDate, description: "Outgoing transfer", amountMinor: -126_400,
    status: "UNMATCHED", createdAt: Date.now(), createdBy: fx.ownerId,
  }));
  await fx.asOwner.mutation(api.bankReconciliation.confirmMatch, {
    orgId: fx.orgId, statementLineId, journalLineId: outgoing._id,
  });
  const effectsBefore = await sideEffects(fx);
  await expect(fx.asOwner.mutation(api.bankTransfers.reverse, reverse)).rejects.toThrow(/unmatch/i);
  expect(await sideEffects(fx)).toEqual(effectsBefore);
  expect(await balances()).toEqual(new Map([[fromBankAccountId, 873_600], [toBankAccountId, 126_400]]));
  await fx.asOwner.mutation(api.bankReconciliation.unmatch, { orgId: fx.orgId, statementLineId });
  const returned = await fx.asOwner.mutation(api.bankTransfers.reverse, reverse);
  await expect(fx.asOwner.mutation(api.bankTransfers.reverse, reverse)).resolves.toEqual(returned);
  expect((await postedLines(fx, returned.reversalJournalEntryId)).map(line => [line.bankAccountId, line.debitMinor, line.creditMinor]))
    .toEqual([[toBankAccountId, 0, 126_400], [fromBankAccountId, 126_400, 0]]);
  expect(await balances()).toEqual(new Map([[fromBankAccountId, 1_000_000], [toBankAccountId, 0]]));
  const newerIds: Id<"accountingEvents">[] = [];
  for (const index of Array.from({ length: 20 }, (_, number) => number)) {
    const newer = await fx.asOwner.mutation(api.bankTransfers.record, {
      ...command, amountMinor: 1, reference: "Newer confirmation " + index, idempotencyKey: "newer-transfer-" + index,
    });
    newerIds.unshift(newer.eventId);
  }
  const newest = await fx.asOwner.query(api.bankTransfers.recent, { orgId: fx.orgId });
  expect(newest?.transfers.map(entry => entry.eventId)).toEqual(newerIds);
  if (!newest?.nextCursor) throw new Error("Expected a cursor to the older transfer");
  const older = await fx.asOwner.query(api.bankTransfers.recent, { orgId: fx.orgId, cursor: newest.nextCursor });
  expect(older?.nextCursor).toBeNull();
  expect(older?.transfers).toEqual([
    expect.objectContaining({ fromBankName: "Funding bank", toBankName: "Newly funded bank", reversed: true }),
  ]);
});

test("moves exact cash and bank amounts in both directions after the drawer is settled", async () => {
  const fx = await seed();
  const bankAccountId = await fx.createBank("Destination bank");
  const drawerId = await fx.t.run(ctx => ctx.db.insert("cashDrawerSessions", {
    orgId: fx.orgId, currency: "JOD", openingFloatMinor: 20_000,
    openedBy: fx.ownerId, openedAt: Date.now(), status: "OPEN",
  }));
  const deposit = {
    orgId: fx.orgId, currency: "JOD", fromBankAccountId: null, toBankAccountId: bankAccountId,
    amountMinor: 11_400, accountingDate: Date.now(), reference: "Cash deposit receipt", idempotencyKey: "cash-deposit",
  };
  for (const status of ["OPEN", "COUNTING", "CLOSED"] as const) {
    await fx.t.run(ctx => ctx.db.patch(drawerId, { status }));
    await expect(fx.asOwner.mutation(api.bankTransfers.record, deposit)).rejects.toThrow(/settle the cash drawer/i);
    expect(await sideEffects(fx)).toEqual(NO_SIDE_EFFECTS);
  }
  await fx.t.run(ctx => ctx.db.patch(drawerId, { status: "APPROVED" }));
  const deposited = await fx.asOwner.mutation(api.bankTransfers.record, deposit);
  const withdrawn = await fx.asOwner.mutation(api.bankTransfers.record, {
    ...deposit, fromBankAccountId: bankAccountId, toBankAccountId: null, amountMinor: 1_200,
    reference: "Cash withdrawal receipt", idempotencyKey: "cash-withdrawal",
  });
  const directions = async (id: Id<"journalEntries">) =>
    (await postedLines(fx, id)).map(line => [line.accountId, line.bankAccountId, line.debitMinor, line.creditMinor]);
  expect(await directions(deposited.journalEntryId)).toEqual([
    [fx.bankControlId, bankAccountId, 11_400, 0], [fx.cashId, undefined, 0, 11_400],
  ]);
  expect(await directions(withdrawn.journalEntryId)).toEqual([
    [fx.cashId, undefined, 1_200, 0], [fx.bankControlId, bankAccountId, 0, 1_200],
  ]);
  const liquidity = await fx.asOwner.query(api.dashboardLiquidity.liquidity, { orgId: fx.orgId });
  if (!liquidity) throw new Error("Expected finance liquidity for the owner");
  expect(liquidity.cash).toContainEqual({ currency: "JOD", balanceMinor: -10_200 });
  expect(liquidity.bankTotals).toContainEqual({ currency: "JOD", balanceMinor: 10_200 });
  expect(liquidity.cashAndBankTotals).toContainEqual({ currency: "JOD", balanceMinor: 0 });
  expect(await fx.t.run(ctx => ctx.db.query("cashMovements").collect())).toEqual([]);
  expect(await fx.t.run(ctx => ctx.db.query("transactions").collect())).toEqual([]);
});

test("rejects invalid, cross-tenant and unauthorized transfer commands before writing", async () => {
  const fx = await seed();
  const fromBankAccountId = await fx.createBank("Source bank");
  const toBankAccountId = await fx.createBank("Other local bank");
  const differentCurrency = await fx.createBank("Dollar bank", "USD");
  const foreign = await fx.t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() });
    return ctx.db.insert("bankAccounts", {
      orgId, name: "Other dealer bank", currency: "JOD", openingBalanceMinor: 0,
      openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: false,
      createdBy: fx.ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  await fx.t.run(async ctx => {
    const roleId = await ctx.db.insert("roles", { orgId: fx.orgId, name: "Viewer", permissions: ["view:finance"] });
    const userId = await ctx.db.insert("users", { clerkId: "obb_viewer", email: "obb_viewer@example.com", name: "Viewer" });
    await ctx.db.insert("memberships", { orgId: fx.orgId, userId, roleId });
  });
  const viewer = fx.t.withIdentity({ subject: "obb_viewer", clerkId: "obb_viewer" });
  const command = {
    orgId: fx.orgId, currency: "JOD", fromBankAccountId, toBankAccountId, amountMinor: 126_400,
    accountingDate: Date.now(), reference: "Confirmed transfer", idempotencyKey: "invalid-transfer",
  };
  for (const change of [
    { toBankAccountId: fromBankAccountId }, { toBankAccountId: differentCurrency },
    { toBankAccountId: foreign }, { fromBankAccountId: foreign },
    { amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: NaN },
    { accountingDate: Date.now() + 86_400_000 }, { accountingDate: 0 }, { reference: " " },
  ]) {
    await expect(fx.asOwner.mutation(api.bankTransfers.record, { ...command, ...change })).rejects.toThrow();
  }
  await expect(viewer.mutation(api.bankTransfers.record, command)).rejects.toThrow();
  const [period] = await fx.asOwner.query(api.accountingPeriods.list, { orgId: fx.orgId });
  await fx.t.run(ctx => ctx.db.patch(period._id, { status: "CLOSED" }));
  await expect(fx.asOwner.mutation(api.bankTransfers.record, command)).rejects.toThrow(/period/i);
  expect(await viewer.query(api.bankTransfers.recent, { orgId: fx.orgId })).toEqual({ transfers: [], nextCursor: null });
  expect(await sideEffects(fx)).toEqual(NO_SIDE_EFFECTS);
  expect(await fx.t.run(ctx => ctx.db.query("accountingEvents").collect())).toEqual([]);
});

test("distinguishes a new bank's later statement from a genuine dated opening difference", async () => {
  const fx = await seed();
  const bankId = await fx.createBank("Opening bank");
  const preRegistered = await fx.createBank("Already registered");
  const { journalId } = await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx, bankId));
  const referenceAmount = 126_400;
  const cutoffDifference = 63_200;
  const later = await fx.createBank("Later bank statement");
  const lateRegistration = await fx.createBank("Existing at cutoff");
  await fx.t.run(async ctx => {
    const id = ctx.db.normalizeId("journalEntries", journalId);
    const journal = id ? await ctx.db.get(id) : null;
    if (!journal?.postedAt || journal.accountingDate === undefined) throw new Error("Expected the posted opening");
    const createdAt = journal.postedAt + 1;
    await ctx.db.patch(bankId, { openingBalanceMinor: 1_126_400, openingBalanceDate: journal.accountingDate + 86_400_000 });
    await ctx.db.patch(preRegistered, { openingBalanceMinor: referenceAmount, openingBalanceDate: journal.accountingDate + 86_400_000 });
    await ctx.db.patch(later, { createdAt, openingBalanceMinor: referenceAmount, openingBalanceDate: journal.accountingDate + 86_400_000 });
    await ctx.db.patch(lateRegistration, { createdAt, openingBalanceMinor: cutoffDifference, openingBalanceDate: journal.accountingDate });
  });
  const economicRows = () => fx.t.run(async ctx => ({
    events: await ctx.db.query("accountingEvents").collect(),
    transactions: await ctx.db.query("transactions").collect(),
  }));
  const before = await sideEffects(fx);
  const commands = await economicRows();
  const figures = await fx.asOwner.query(api.bankAccounts.openingReconciliation, { orgId: fx.orgId });
  expect(figures.banks.find(row => row.bankAccountId === later)).toMatchObject({
    referenceOpeningMinor: referenceAmount, openingLineMinor: 0, differenceMinor: null, referenceAfterOpening: true,
  });
  expect(figures.banks.find(row => row.bankAccountId === bankId)).toMatchObject({
    openingLineMinor: 1_000_000, referenceAfterOpening: true, differenceMinor: null,
  });
  expect(figures.banks.find(row => row.bankAccountId === preRegistered)).toMatchObject({
    openingLineMinor: 0, referenceAfterOpening: true, differenceMinor: null,
  });
  expect(figures.banks.find(row => row.bankAccountId === lateRegistration)).toMatchObject({
    referenceOpeningMinor: cutoffDifference, openingLineMinor: 0, differenceMinor: cutoffDifference,
  });
  expect(figures.unexplainedOpeningDifference?.currencies).toEqual([
    { currency: "JOD", differenceMinor: cutoffDifference, absoluteDifferenceMinor: cutoffDifference },
  ]);
  expect(await sideEffects(fx)).toEqual(before);
  expect(await economicRows()).toEqual(commands);
});

describe("SCRUM-54 opening balance names the physical bank", () => {
  test("owner direct post stamps the chosen bank on the BANK_ACCOUNT line only, and the book balance is then attributed", async () => {
    const fx = await seed();
    const bankId = await fx.createBank("Arab Bank JOD", "JOD", true);

    const { journalId } = await fx.asOwner.mutation(
      api.accountingCutover.postOpeningBalanceDirect,
      bankOpening(fx, bankId)
    );

    const lines = await postedLines(fx, journalId);
    const bankLine = lines.find((l) => l.accountId === fx.bankControlId);
    const syntheticOffsetLine = lines.find((l) => l.accountId === fx.syntheticOffsetId);
    expect(bankLine?.bankAccountId).toBe(bankId);
    expect(syntheticOffsetLine?.bankAccountId).toBeUndefined();

    const book = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(book).toMatchObject({ status: "OK", balanceMinor: 1_000_000, unattributedLineCount: 0 });
  });

  test("two banks in one opening each keep their own balance", async () => {
    const fx = await seed();
    const bankA = await fx.createBank("Bank A", "JOD", true);
    const bankB = await fx.createBank("Bank B");

    const { journalId } = await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: fx.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: fx.bankControlId, debitMinor: 700_000, creditMinor: 0, bankAccountId: bankA },
        { accountId: fx.bankControlId, debitMinor: 300_000, creditMinor: 0, bankAccountId: bankB },
        { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: 1_000_000 },
      ],
    });

    const stamped = (await postedLines(fx, journalId)).filter((l) => l.accountId === fx.bankControlId);
    expect(stamped.map((l) => [l.debitMinor, l.bankAccountId]).sort()).toEqual(
      [[300_000, bankB], [700_000, bankA]].sort()
    );
    const book = await fx.asOwner.query(api.bankAccounts.getBookBalance, { orgId: fx.orgId });
    expect(book).toMatchObject({ status: "OK", balanceMinor: 700_000 });
  });

  test("two-person path keeps the bank on the draft, shows it to the approver, and stamps it when approved", async () => {
    const fx = await seed();
    const bankId = await fx.createBank("Housing Bank", "JOD", true);

    const { draftId } = await fx.asAccountant.mutation(
      api.accountingCutover.draftOpeningBalance,
      bankOpening(fx, bankId)
    );

    const stored = await fx.t.run((ctx) => ctx.db.get(draftId as Id<"openingBalanceDrafts">));
    expect(stored?.lines.find((l) => l.accountId === fx.bankControlId)?.bankAccountId).toBe(bankId);

    // What the approver is shown: the bank identity per line, absent on non-bank lines.
    const pending = await fx.asOwner.query(api.accountingCutover.listPendingOpeningBalanceDrafts, {
      orgId: fx.orgId,
    });
    const shownBank = pending[0].lines.find((l) => l.accountId === fx.bankControlId);
    const shownSyntheticOffset = pending[0].lines.find((l) => l.accountId === fx.syntheticOffsetId);
    expect(shownBank).toMatchObject({ bankAccountId: bankId, bankAccountName: "Housing Bank", requiresBankAccount: true });
    expect(shownSyntheticOffset).toMatchObject({ bankAccountName: null, requiresBankAccount: false });

    const { journalId } = await fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0,
      orgId: fx.orgId,
      draftId: draftId as Id<"openingBalanceDrafts">,
    });
    const bankLine = (await postedLines(fx, journalId)).find((l) => l.accountId === fx.bankControlId);
    expect(bankLine?.bankAccountId).toBe(bankId);
  });

  test("the preparer still cannot approve their own bank draft", async () => {
    const fx = await seed();
    const bankId = await fx.createBank("Cairo Amman Bank");
    const { draftId } = await fx.asOwner.mutation(
      api.accountingCutover.draftOpeningBalance,
      bankOpening(fx, bankId)
    );
    await expect(
      fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0,
        orgId: fx.orgId,
        draftId: draftId as Id<"openingBalanceDrafts">,
      })
    ).rejects.toThrow(/cannot be the same as the preparer/i);
    expect((await sideEffects(fx)).entries).toBe(0);
  });

  test("an opening with no bank-control line posts exactly as before", async () => {
    const fx = await seed();
    const { journalId } = await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: fx.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: fx.cashId, debitMinor: 500_000, creditMinor: 0 },
        { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: 500_000 },
      ],
    });
    const lines = await postedLines(fx, journalId);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.bankAccountId === undefined)).toBe(true);
  });

  test("direct post: existing ledger activity wins over a missing bank identity, with the stable coded refusal", async () => {
    const fx = await seed();
    // The bank-control line is chosen by systemKey above (never by chart order)
    // and names no bank, so BOTH guards would refuse; the late-opening code must win.
    await fx.t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId: fx.orgId,
        journalNumber: "JE-LATE-1",
        accountingDate: Date.now(),
        sourceType: "test",
        sourceId: "late-1",
        category: "SYSTEM",
        memo: "Existing posted activity",
        status: "POSTED",
        currency: "JOD",
        postedBy: fx.ownerId,
        postedAt: Date.now(),
        createdAt: Date.now(),
      })
    );
    const before = await sideEffects(fx);

    let code: string | undefined;
    try {
      await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx));
    } catch (error) {
      code = (error as { data?: { code?: string } }).data?.code;
    }

    expect(code).toBe("OPENING_BALANCE_AFTER_LEDGER_ACTIVITY");
    expect(await sideEffects(fx)).toEqual(before);
  });

  describe("refuses before any draft, journal or snapshot is written", () => {
    type Mk = (fx: Fx) => Promise<{ lines: ReturnType<typeof bankOpening>["lines"]; message: RegExp }>;

    const cases: Array<[string, Mk]> = [
      [
        "bank line with no bank selected",
        async (fx) => ({ lines: bankOpening(fx).lines, message: /select a bank account/i }),
      ],
      [
        "bank belonging to another organization",
        async (fx) => {
          const otherOrg = await fx.t.run((ctx) =>
            ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
          );
          const foreign = await fx.t.run((ctx) =>
            ctx.db.insert("bankAccounts", {
              orgId: otherOrg,
              name: "Foreign",
              currency: "JOD",
              openingBalanceMinor: 0,
              openingBalanceDate: Date.now(),
              isActive: true,
              isReconciliationTarget: false,
              createdBy: fx.ownerId,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
          );
          return { lines: bankOpening(fx, foreign).lines, message: /not found in this organization/i };
        },
      ],
      [
        "deleted bank",
        async (fx) => {
          const bankId = await fx.createBank("Closed Bank");
          await fx.asOwner.mutation(api.bankAccounts.deactivate, { orgId: fx.orgId, bankAccountId: bankId });
          return { lines: bankOpening(fx, bankId).lines, message: /not found in this organization/i };
        },
      ],
      [
        "inactive bank",
        async (fx) => {
          const bankId = await fx.createBank("Dormant Bank");
          await fx.t.run((ctx) => ctx.db.patch(bankId, { isActive: false }));
          return { lines: bankOpening(fx, bankId).lines, message: /bank account is inactive/i };
        },
      ],
      [
        "bank in a different currency than the opening",
        async (fx) => {
          const bankId = await fx.createBank("Dollar Bank", "USD");
          return { lines: bankOpening(fx, bankId).lines, message: /denominated in USD.*opening balance is in JOD/i };
        },
      ],
      [
        "bank named on a line that is not the bank control account",
        async (fx) => {
          const bankId = await fx.createBank("Arab Bank");
          return {
            lines: [
              { accountId: fx.cashId, debitMinor: 1_000_000, creditMinor: 0, bankAccountId: bankId },
              { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: 1_000_000 },
            ],
            message: /only a bank account line/i,
          };
        },
      ],
    ];

    for (const route of ["postOpeningBalanceDirect", "draftOpeningBalance"] as const) {
      for (const [name, make] of cases) {
        test(`${route}: ${name}`, async () => {
          const fx = await seed();
          const { lines, message } = await make(fx);
          const before = await sideEffects(fx);
          expect(before).toEqual(NO_SIDE_EFFECTS);

          await expect(
            fx.asOwner.mutation(api.accountingCutover[route], {
              orgId: fx.orgId,
              expectedCurrency: "JOD",
              asOfDate: Date.now(),
              lines,
            })
          ).rejects.toThrow(message);

          expect(await sideEffects(fx)).toEqual(NO_SIDE_EFFECTS);
        });
      }
    }
  });

  describe("re-validated when the draft is approved", () => {
    test("a bank removed between draft and approval blocks the posting and leaves the draft pending", async () => {
      const fx = await seed();
      const bankId = await fx.createBank("Short Lived Bank");
      const { draftId } = await fx.asAccountant.mutation(
        api.accountingCutover.draftOpeningBalance,
        bankOpening(fx, bankId)
      );
      await fx.asOwner.mutation(api.bankAccounts.deactivate, { orgId: fx.orgId, bankAccountId: bankId });

      await expect(
        fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0,
          orgId: fx.orgId,
          draftId: draftId as Id<"openingBalanceDrafts">,
        })
      ).rejects.toThrow(/not found in this organization/i);

      expect(await sideEffects(fx)).toEqual({ ...NO_SIDE_EFFECTS, drafts: 1 });
      const draft = await fx.t.run((ctx) => ctx.db.get(draftId as Id<"openingBalanceDrafts">));
      expect(draft?.status).toBe("PENDING_APPROVAL");
    });

    test("a pre-existing pending draft whose bank line names no bank cannot be approved", async () => {
      const fx = await seed();
      // Written directly: this is the shape of a draft saved before bank identity existed.
      const draftId = await fx.t.run((ctx) =>
        ctx.db.insert("openingBalanceDrafts", {
          orgId: fx.orgId,
          status: "PENDING_APPROVAL",
          lines: [
            { accountId: fx.bankControlId, debitMinor: 1_000_000, creditMinor: 0 },
            { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: 1_000_000 },
          ],
          asOfDate: Date.now(),
          createdBy: fx.ownerId,
          createdAt: Date.now(),
          currency: "JOD",
        })
      );

      await expect(
        fx.asAccountant.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0, orgId: fx.orgId, draftId })
      ).rejects.toThrow(/select a bank account/i);

      expect(await sideEffects(fx)).toEqual({ ...NO_SIDE_EFFECTS, drafts: 1 });

      const pending = await fx.asOwner.query(api.accountingCutover.listPendingOpeningBalanceDrafts, {
        orgId: fx.orgId,
      });
      const shown = pending[0].lines.find((l) => l.accountId === fx.bankControlId);
      expect(shown?.bankAccountId).toBeUndefined();
      expect(shown).toMatchObject({ bankAccountName: null, requiresBankAccount: true });
    });
  });
});
