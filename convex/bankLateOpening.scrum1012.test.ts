/**
 * SCRUM-1012 (owner ruling 2026-11-26): a bank account created after the organization's opening entry stores its
 * opening balance as metadata only, so its book balance reads 0. The owner can post that stored balance once,
 * against Opening suspense (1900): debit the bank, credit 1900. Nothing typed by the client decides the amount
 * or the date. Serial convex-test evidence; no platform, OCC or production claim.
 */
import { describe, expect, test, vi } from "vitest";
import {
  bankOpening, postedLines, seedBankOpeningFixture as seed, treasuryEffects,
  type BankOpeningFixture as Fx,
} from "../test-utils/openingBalanceBankFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { postAccountingEvent } from "./accounting/postingEngine";
import { reverseAccountingEvent } from "./accounting/reversals";

const LATE_AMOUNT = 250_000;
const OPENING_AMOUNT = 1_000_000;

/** The org opening names bank A; bank B is created afterwards with a stated opening of 250.000 JOD. */
async function seedLate(amount = LATE_AMOUNT) {
  const fx = await seed();
  const bankA = await fx.createBank("Opening bank", "JOD", true);
  await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx, bankA, OPENING_AMOUNT));
  const bankB = await fx.asOwner.mutation(api.bankAccounts.create, {
    orgId: fx.orgId, name: "Late bank", currency: "JOD", openingBalanceMinor: amount, openingBalanceDate: Date.now(),
  });
  return { fx, bankA, bankB };
}

const post = (fx: Fx, bankAccountId: Id<"bankAccounts">, idempotencyKey = "late-open-1") =>
  fx.asOwner.mutation(api.bankAccounts.postLateOpeningBalance, { orgId: fx.orgId, bankAccountId, idempotencyKey });

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? "UNCODED:" + String(error);
  }
  return undefined;
}

async function state(fx: Fx) {
  return { ...(await treasuryEffects(fx)), banks: await fx.t.run((ctx) => ctx.db.query("bankAccounts").collect()) };
}

async function suspenseId(fx: Fx): Promise<Id<"chartOfAccounts">> {
  return fx.t.run(async (ctx) => {
    const account = await ctx.db.query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", fx.orgId).eq("systemKey", "OPENING_SUSPENSE")).first();
    if (!account) throw new Error("Opening suspense account missing");
    return account._id;
  });
}

async function balances(fx: Fx) {
  const rows = await fx.asOwner.query(api.bankAccounts.listBookBalances, { orgId: fx.orgId });
  return new Map(rows.map((row) => [row.bankAccountId, row.balanceMinor]));
}

describe("SCRUM-1012 late bank opening balance", () => {
  test("posts the stored opening of a bank created after cutover against opening suspense", async () => {
    const { fx, bankA, bankB } = await seedLate();
    expect(await balances(fx)).toEqual(new Map([[bankA, OPENING_AMOUNT], [bankB, 0]]));
    expect(await fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId })).toEqual([
      expect.objectContaining({ bankAccountId: bankB, name: "Late bank", currency: "JOD", amountMinor: LATE_AMOUNT }),
    ]);

    const posted = await post(fx, bankB);

    const rows = await postedLines(fx, posted.journalEntryId);
    const suspense = await suspenseId(fx);
    expect(rows.sort((a, b) => a.lineNumber - b.lineNumber).map((line) =>
      [line.accountId, line.bankAccountId, line.debitMinor, line.creditMinor, line.currency],
    )).toEqual([
      [fx.bankControlId, bankB, LATE_AMOUNT, 0, "JOD"],
      [suspense, undefined, 0, LATE_AMOUNT, "JOD"],
    ]);
    const journal = await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId));
    expect(journal).toMatchObject({ status: "POSTED", sourceType: "bankOpeningBalances", sourceId: String(bankB), category: "ADJUSTMENT", currency: "JOD" });
    const event = await fx.t.run((ctx) => ctx.db.get(posted.eventId));
    expect(event).toMatchObject({ eventType: "BANK_OPENING_BALANCE_LATE", sourceType: "bankOpeningBalances", sourceId: String(bankB), status: "POSTED" });
    // The book balance now equals the stored opening; the first bank is untouched; the offer is gone.
    expect(await balances(fx)).toEqual(new Map([[bankA, OPENING_AMOUNT], [bankB, LATE_AMOUNT]]));
    expect(await fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId })).toEqual([]);
    // The ledger stays balanced and suspense moved by exactly the amount.
    const all = await fx.t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(all.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0)).toBe(0);
    expect(all.filter((line) => line.accountId === suspense).reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0)).toBe(LATE_AMOUNT);
    // The organization's own opening journal is untouched, so the single-opening guards still see one opening.
    const openings = await fx.t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(openings.filter((entry) => entry.category === "OPENING_BALANCE")).toHaveLength(1);
  });

  test("replaying the same request returns the first result and writes nothing; a new key is refused as already posted", async () => {
    const { fx, bankB } = await seedLate();
    const first = await post(fx, bankB);
    const afterFirst = await state(fx);

    expect(await post(fx, bankB)).toEqual(first);
    expect(await state(fx)).toEqual(afterFirst);

    expect(await codeOf(post(fx, bankB, "late-open-2"))).toBe("LATE_BANK_OPENING_ALREADY_POSTED");
    expect(await state(fx)).toEqual(afterFirst);
  });

  describe("refuses with a coded error and leaves every table unchanged", () => {
    const cases: Array<[string, string, (ctx: Awaited<ReturnType<typeof seedLate>>) => Promise<Id<"bankAccounts">>]> = [
      ["inactive bank", "LATE_BANK_OPENING_BANK_UNAVAILABLE", async ({ fx, bankB }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankB, { isActive: false }));
        return bankB;
      }],
      ["deleted bank", "LATE_BANK_OPENING_BANK_UNAVAILABLE", async ({ fx, bankB }) => {
        await fx.asOwner.mutation(api.bankAccounts.deactivate, { orgId: fx.orgId, bankAccountId: bankB });
        return bankB;
      }],
      ["another organization's bank", "LATE_BANK_OPENING_BANK_UNAVAILABLE", async ({ fx }) => fx.t.run(async (ctx) => {
        const otherOrg = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
        return ctx.db.insert("bankAccounts", {
          orgId: otherOrg, name: "Foreign", currency: "JOD", openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: Date.now(),
          isActive: true, isReconciliationTarget: false, createdBy: fx.ownerId, createdAt: Date.now(), updatedAt: Date.now(),
        });
      })],
      ["stored opening of zero", "LATE_BANK_OPENING_INVALID_BALANCE", async ({ fx, bankB }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceMinor: 0 }));
        return bankB;
      }],
      ["negative stored opening", "LATE_BANK_OPENING_INVALID_BALANCE", async ({ fx, bankB }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceMinor: -5 }));
        return bankB;
      }],
      ["stored opening that is not a whole number of minor units", "LATE_BANK_OPENING_INVALID_BALANCE", async ({ fx, bankB }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceMinor: 12.5 }));
        return bankB;
      }],
      ["stored opening date in the future", "LATE_BANK_OPENING_INVALID_BALANCE", async ({ fx, bankB }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: Date.now() + 3 * 86_400_000 }));
        return bankB;
      }],
      ["a bank already named by the organization's opening entry", "LATE_BANK_OPENING_ALREADY_POSTED", async ({ fx, bankA }) => {
        await fx.t.run((ctx) => ctx.db.patch(bankA, { openingBalanceMinor: OPENING_AMOUNT }));
        return bankA;
      }],
      ["a closed period", "LATE_BANK_OPENING_PERIOD_UNAVAILABLE", async ({ fx, bankB }) => {
        const [period] = await fx.asOwner.query(api.accountingPeriods.list, { orgId: fx.orgId });
        await fx.t.run((ctx) => ctx.db.patch(period._id, { status: "CLOSED" }));
        return bankB;
      }],
    ];
    test.each(cases)("%s -> %s", async (_name, code, arrange) => {
      const seeded = await seedLate();
      const target = await arrange(seeded);
      const before = await state(seeded.fx);
      expect(await codeOf(post(seeded.fx, target))).toBe(code);
      expect(await state(seeded.fx)).toEqual(before);
    });
  });

  test("an organization with no posted opening entry is told to use the normal opening door", async () => {
    const fx = await seed();
    const bank = await fx.asOwner.mutation(api.bankAccounts.create, {
      orgId: fx.orgId, name: "Early bank", currency: "JOD", openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: Date.now(),
    });
    const before = await state(fx);
    expect(await codeOf(post(fx, bank))).toBe("LATE_BANK_OPENING_NO_ORG_OPENING");
    expect(await state(fx)).toEqual(before);
    // The offer is listed so the owner sees why, but the server marks it as not postable.
    const offers = await fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId });
    expect(offers).toEqual([expect.objectContaining({ bankAccountId: bank, canPostLateOpening: false })]);
  });

  test("only the owner, and never a non-owner finance user, can post or see the offer", async () => {
    const { fx, bankB } = await seedLate();
    const before = await state(fx);
    expect(await codeOf(fx.asAccountant.mutation(api.bankAccounts.postLateOpeningBalance, {
      orgId: fx.orgId, bankAccountId: bankB, idempotencyKey: "accountant-attempt",
    }))).toBe("LATE_BANK_OPENING_OWNER_ONLY");
    expect(await state(fx)).toEqual(before);
    expect(await fx.asAccountant.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId })).toEqual([]);
    const stranger = fx.t.withIdentity({ subject: "late_open_stranger", clerkId: "late_open_stranger" });
    expect(await codeOf(stranger.mutation(api.bankAccounts.postLateOpeningBalance, {
      orgId: fx.orgId, bankAccountId: bankB, idempotencyKey: "stranger",
    }))).toBeDefined();
    expect(await state(fx)).toEqual(before);
  });

  test("the stored opening and date cannot be edited once an opening line exists for the bank", async () => {
    const { fx, bankA, bankB } = await seedLate();
    // Before posting nothing exists for bank B, so its reference figures may still be corrected.
    await fx.asOwner.mutation(api.bankAccounts.update, { orgId: fx.orgId, bankAccountId: bankB, openingBalanceMinor: 300_000 });
    await fx.asOwner.mutation(api.bankAccounts.update, { orgId: fx.orgId, bankAccountId: bankB, openingBalanceMinor: LATE_AMOUNT });
    await post(fx, bankB);
    const before = await state(fx);
    for (const bankAccountId of [bankB, bankA]) {
      expect(await codeOf(fx.asOwner.mutation(api.bankAccounts.update, { orgId: fx.orgId, bankAccountId, openingBalanceMinor: 1 })))
        .toBe("LATE_BANK_OPENING_EDIT_REFUSED");
      expect(await codeOf(fx.asOwner.mutation(api.bankAccounts.update, { orgId: fx.orgId, bankAccountId, openingBalanceDate: 1 })))
        .toBe("LATE_BANK_OPENING_EDIT_REFUSED");
    }
    expect(await state(fx)).toEqual(before);
    // Descriptive fields stay editable, and re-sending the same figures is not a change.
    const stored = await fx.t.run((ctx) => ctx.db.get(bankB));
    await fx.asOwner.mutation(api.bankAccounts.update, {
      orgId: fx.orgId, bankAccountId: bankB, name: "Late bank renamed",
      openingBalanceMinor: stored?.openingBalanceMinor, openingBalanceDate: stored?.openingBalanceDate,
    });
    expect((await fx.t.run((ctx) => ctx.db.get(bankB)))?.name).toBe("Late bank renamed");
  });

  test("a posted late opening cannot be reversed through the ledger, and no other caller can post a different figure", async () => {
    const { fx, bankA, bankB } = await seedLate();
    const posted = await post(fx, bankB);
    const before0 = await state(fx);
    expect(await codeOf(fx.t.run((ctx) => reverseAccountingEvent(ctx, {
      orgId: fx.orgId, originalEventId: posted.eventId, reversalDate: Date.now(), reason: "undo", actorId: fx.ownerId,
      idempotencyKey: "reverse-late-opening",
    })))).toBe("LATE_BANK_OPENING_NOT_REVERSIBLE");
    expect(await codeOf(fx.asOwner.mutation(api.bankTransfers.reverse, {
      orgId: fx.orgId, eventId: posted.eventId, accountingDate: Date.now(), reason: "undo", idempotencyKey: "reverse-via-transfers",
    }))).toBeDefined();
    expect(await state(fx)).toEqual(before0);

    // The posting engine re-derives amount and date from the stored bank, so a caller cannot choose them.
    const other = await fx.asOwner.mutation(api.bankAccounts.create, {
      orgId: fx.orgId, name: "Third bank", currency: "JOD", openingBalanceMinor: 40_000, openingBalanceDate: Date.now(),
    });
    const before = await state(fx);
    const forged = (amountMinor: number, bankAccountId: Id<"bankAccounts">) => fx.t.run((ctx) => postAccountingEvent(ctx, {
      orgId: fx.orgId, eventType: "BANK_OPENING_BALANCE_LATE", sourceType: "bankOpeningBalances", sourceId: String(bankAccountId),
      eventVersion: 1, accountingDate: Date.now(), occurredAt: Date.now(), currency: "JOD",
      payload: { bankAccountId: String(bankAccountId), amountMinor }, actorId: fx.ownerId,
      idempotencyKey: "forged-" + amountMinor + String(bankAccountId),
    }));
    await expect(forged(40_001, other)).rejects.toThrow(/could not be verified/i);
    await expect(forged(40_000, bankA)).rejects.toThrow();
    expect(await state(fx)).toEqual(before);
  });

  test("the opening reconciliation reads a late-opened bank as explained, not as an unexplained opening difference", async () => {
    const { fx, bankB } = await seedLate();
    // Dated on the organization's own opening day, so before posting the stated figure reads as a difference.
    const reconcile = () => fx.asOwner.query(api.bankAccounts.openingReconciliation, { orgId: fx.orgId });
    // The fixture's bank A states 0 but the opening put 1.000.000 on it; that pre-existing difference is not this change's.
    const bankAOnly = { currency: "JOD", differenceMinor: -OPENING_AMOUNT, absoluteDifferenceMinor: OPENING_AMOUNT };
    expect((await reconcile()).unexplainedOpeningDifference?.currencies).toEqual([
      { currency: "JOD", differenceMinor: LATE_AMOUNT - OPENING_AMOUNT, absoluteDifferenceMinor: LATE_AMOUNT + OPENING_AMOUNT },
    ]);
    await post(fx, bankB);
    const after = await reconcile();
    expect(after.status).toBe("OK");
    expect(after.unexplainedOpeningDifference?.currencies).toEqual([bankAOnly]);
    expect(after.controlOpeningMinor).toBe(OPENING_AMOUNT);
    expect(after.banks.find((row) => row.bankAccountId === bankB)).toMatchObject({
      referenceOpeningMinor: LATE_AMOUNT, openingLineMinor: 0, differenceMinor: null, lateOpeningPosted: true,
    });
  });

  describe("never before the organization's posted opening date", () => {
    const DAY = 86_400_000;
    const orgOpening = (fx: Fx) => fx.t.run(async (ctx) => {
      const journals = await ctx.db.query("journalEntries").collect();
      const opening = journals.find((entry) => entry.category === "OPENING_BALANCE");
      if (!opening || opening.accountingDate === undefined) throw new Error("Organization opening missing");
      return { id: opening._id, date: opening.accountingDate };
    });

    test("a bank dated before the opening is refused, is not offered as postable, and says why", async () => {
      const { fx, bankB } = await seedLate();
      const opening = await orgOpening(fx);
      await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: opening.date - 2 * DAY }));
      const before = await state(fx);
      expect(await codeOf(post(fx, bankB))).toBe("LATE_BANK_OPENING_BEFORE_CUTOVER");
      expect(await state(fx)).toEqual(before);
      expect(await fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId })).toEqual([
        expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: false, blockedReason: "LATE_BANK_OPENING_BEFORE_CUTOVER" }),
      ]);
    });

    test("a bank dated on the opening day posts", async () => {
      const { fx, bankB } = await seedLate();
      const opening = await orgOpening(fx);
      await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: opening.date }));
      const posted = await post(fx, bankB);
      expect((await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId)))?.accountingDate).toBe(opening.date);
    });

    test("a bank dated after the opening day posts", async () => {
      const { fx, bankB } = await seedLate();
      const opening = await orgOpening(fx);
      // The opening is proven by its own date, so move the clock instead: the bank is dated the next day.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(opening.date + DAY);
        await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: opening.date + DAY }));
        const posted = await post(fx, bankB);
        expect((await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId)))?.accountingDate).toBe(opening.date + DAY);
      } finally {
        vi.useRealTimers();
      }
    });

    test("the owner corrects the bank's date with update, then the opening posts", async () => {
      const { fx, bankB } = await seedLate();
      const opening = await orgOpening(fx);
      await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: opening.date - 2 * DAY }));
      expect(await codeOf(post(fx, bankB))).toBe("LATE_BANK_OPENING_BEFORE_CUTOVER");
      await fx.asOwner.mutation(api.bankAccounts.update, { orgId: fx.orgId, bankAccountId: bankB, openingBalanceDate: opening.date });
      expect(await fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId })).toEqual([
        expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: true }),
      ]);
      const posted = await post(fx, bankB);
      expect((await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId)))?.accountingDate).toBe(opening.date);
    });
  });
});
