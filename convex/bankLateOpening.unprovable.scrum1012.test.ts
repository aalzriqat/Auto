/**
 * SCRUM-1012 review F1 + F3. A late bank opening may be posted only when the organization's posted opening PROVES which
 * banks it already covers (every BANK_ACCOUNT control line names a bank that resolves to this organization), and the
 * owner posts exactly the figures the screen showed. Serial convex-test evidence; no platform, OCC or production claim.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bankOpening, seedBankOpeningFixture as seed, treasuryEffects, type BankOpeningFixture as Fx,
} from "../test-utils/openingBalanceBankFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const LATE_AMOUNT = 250_000;
const OPENING_AMOUNT = 1_000_000;
const NOW = Date.UTC(2026, 5, 15, 10, 0, 0);
const UNPROVABLE = "LATE_BANK_OPENING_OPENING_UNPROVABLE";

/** The org opening names bank A; bank B is created afterwards with a stated opening of 250.000 JOD dated NOW. */
async function seedLate() {
  const fx = await seed();
  const bankA = await fx.createBank("Opening bank", "JOD", true);
  await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx, bankA, OPENING_AMOUNT));
  const bankB = await fx.asOwner.mutation(api.bankAccounts.create, {
    orgId: fx.orgId, name: "Late bank", currency: "JOD", openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: NOW,
  });
  return { fx, bankA, bankB };
}

const post = (
  fx: Fx, bankAccountId: Id<"bankAccounts">,
  expected = { expectedAmountMinor: LATE_AMOUNT, expectedOpeningBalanceDate: NOW }, idempotencyKey = "late-open-1",
) => fx.asOwner.mutation(api.bankAccounts.postLateOpeningBalance, { orgId: fx.orgId, bankAccountId, idempotencyKey, ...expected });

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? "UNCODED:" + String(error);
  }
  return undefined;
}

const state = (fx: Fx) => treasuryEffects(fx);
const offers = (fx: Fx) => fx.asOwner.query(api.bankAccounts.lateOpeningOffers, { orgId: fx.orgId });

/** Pre-identity history: the opening's line on bank A no longer names it, names a vanished bank, or names a foreign one. */
async function corruptOpeningLine(fx: Fx, bankA: Id<"bankAccounts">, kind: "unnamed" | "hard-deleted" | "foreign") {
  await fx.t.runUnwrapped(async (ctx) => {
    const line = (await ctx.db.query("journalLines").collect()).find((row) => row.bankAccountId === bankA);
    const bank = await ctx.db.get(bankA);
    if (!line) throw new Error("Missing opening line for bank A");
    if (kind === "unnamed") {
      await ctx.db.patch(line._id, { bankAccountId: undefined });
    } else if (kind === "hard-deleted") {
      await ctx.db.delete(bankA);
    } else {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other bank owner", createdAt: NOW });
      const foreign = await ctx.db.insert("bankAccounts", {
        orgId: otherOrgId, name: "Foreign bank", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: NOW,
        isActive: true, isReconciliationTarget: false, createdBy: bank?.createdBy as Id<"users">, createdAt: NOW, updatedAt: NOW,
      });
      await ctx.db.patch(line._id, { bankAccountId: foreign });
    }
  });
}

describe("SCRUM-1012 F1: an opening that cannot prove which banks it covers allows no late opening", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each(["unnamed", "hard-deleted", "foreign"] as const)(
    "an opening line that is %s: offer blocked, post refused with nothing written, stored figures locked",
    async (kind) => {
      const { fx, bankA, bankB } = await seedLate();
      await corruptOpeningLine(fx, bankA, kind);
      const before = await state(fx);

      expect(await offers(fx)).toEqual([
        expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: false, blockedReason: UNPROVABLE }),
      ]);
      expect(await codeOf(post(fx, bankB))).toBe(UNPROVABLE);
      expect(await state(fx)).toEqual(before);

      expect(await codeOf(fx.asOwner.mutation(api.bankAccounts.update, {
        orgId: fx.orgId, bankAccountId: bankB, openingBalanceMinor: LATE_AMOUNT + 1,
      }))).toBe("LATE_BANK_OPENING_EDIT_UNPROVABLE");
      expect(await codeOf(fx.asOwner.mutation(api.bankAccounts.update, {
        orgId: fx.orgId, bankAccountId: bankB, openingBalanceDate: NOW - 86_400_000,
      }))).toBe("LATE_BANK_OPENING_EDIT_UNPROVABLE");
      expect((await fx.t.run((ctx) => ctx.db.get(bankB)))).toMatchObject({ openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: NOW });
      // Re-sending the stored figures and editing other fields stays allowed: only a change to the opening is locked.
      await fx.asOwner.mutation(api.bankAccounts.update, {
        orgId: fx.orgId, bankAccountId: bankB, openingBalanceMinor: LATE_AMOUNT, notes: "still editable",
      });
    },
  );

  test("opposing unnamed bank lines that net to zero are still unprovable", async () => {
    const { fx, bankA, bankB } = await seedLate();
    await fx.t.runUnwrapped(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      const bankLine = lines.find((row) => row.bankAccountId === bankA);
      if (!bankLine) throw new Error("Missing opening line for bank A");
      // A second bank-control line of the same amount on the other side, naming no bank, and the named line unnamed:
      // the two bank lines now offset each other and the control nets to zero.
      await ctx.db.patch(bankLine._id, { bankAccountId: undefined });
      const { _id, _creationTime, ...copy } = bankLine;
      void _id; void _creationTime;
      await ctx.db.insert("journalLines", {
        ...copy, bankAccountId: undefined, debitMinor: bankLine.creditMinor, creditMinor: bankLine.debitMinor,
      });
    });
    const before = await state(fx);

    expect(await offers(fx)).toEqual([
      expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: false, blockedReason: UNPROVABLE }),
    ]);
    expect(await codeOf(post(fx, bankB))).toBe(UNPROVABLE);
    expect(await state(fx)).toEqual(before);
  });

  test("an opening with no bank line at all still offers the late bank and posts it", async () => {
    const fx = await seed();
    await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: fx.orgId, expectedCurrency: "JOD", asOfDate: NOW,
      lines: [
        { accountId: fx.cashId, debitMinor: OPENING_AMOUNT, creditMinor: 0 },
        { accountId: fx.syntheticOffsetId, debitMinor: 0, creditMinor: OPENING_AMOUNT },
      ],
    });
    const bankB = await fx.asOwner.mutation(api.bankAccounts.create, {
      orgId: fx.orgId, name: "Late bank", currency: "JOD", openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: NOW,
    });

    expect(await offers(fx)).toEqual([expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: true })]);
    const posted = await post(fx, bankB);
    expect((await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId)))?.status).toBe("POSTED");
  });

  test("a bank named on a non-bank-control opening line makes the opening unprovable, reconciliation unchanged", async () => {
    const { fx, bankA, bankB } = await seedLate();
    const reconcile = async () => {
      const result = await fx.asOwner.query(api.bankAccounts.openingReconciliation, { orgId: fx.orgId });
      return { status: result.status, unattributedOpeningMinor: result.unattributedOpeningMinor };
    };
    const reconciliationBefore = await reconcile();
    // Today's doors refuse to create such a line, so seed it directly: the opening's offsetting line names bank A.
    await fx.t.runUnwrapped(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      const bankLine = lines.find((row) => row.bankAccountId === bankA);
      const other = lines.find((row) => row.journalEntryId === bankLine?.journalEntryId && row._id !== bankLine?._id);
      if (!bankLine || !other) throw new Error("Missing opening lines");
      await ctx.db.patch(other._id, { bankAccountId: bankA });
    });
    const before = await state(fx);

    expect(await reconcile()).toEqual(reconciliationBefore);
    expect(await offers(fx)).toEqual([
      expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: false, blockedReason: UNPROVABLE }),
    ]);
    expect(await codeOf(post(fx, bankB))).toBe(UNPROVABLE);
    expect(await state(fx)).toEqual(before);
  });

  test("a soft-deleted bank that the opening names still resolves: the late bank posts", async () => {
    const { fx, bankA, bankB } = await seedLate();
    await fx.t.run((ctx) => ctx.db.patch(bankA, { isDeleted: true }));

    expect(await offers(fx)).toEqual([expect.objectContaining({ bankAccountId: bankB, canPostLateOpening: true })]);
    const posted = await post(fx, bankB);
    expect((await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId)))?.status).toBe("POSTED");
  });
});

describe("SCRUM-1012 F3: the owner posts the figures the screen showed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an amount edited after the offer is refused with nothing written", async () => {
    const { fx, bankB } = await seedLate();
    await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceMinor: 260_000 }));
    const before = await state(fx);

    expect(await codeOf(post(fx, bankB))).toBe("LATE_BANK_OPENING_FIGURES_CHANGED");
    expect(await state(fx)).toEqual(before);
  });

  test("a date edited after the offer is refused with nothing written", async () => {
    const { fx, bankB } = await seedLate();
    await fx.t.run((ctx) => ctx.db.patch(bankB, { openingBalanceDate: NOW - 86_400_000 }));
    const before = await state(fx);

    expect(await codeOf(post(fx, bankB))).toBe("LATE_BANK_OPENING_FIGURES_CHANGED");
    expect(await state(fx)).toEqual(before);
  });

  test("matching expected figures post the stored figures", async () => {
    const { fx, bankB } = await seedLate();
    const posted = await post(fx, bankB, { expectedAmountMinor: 250_000, expectedOpeningBalanceDate: Date.UTC(2026, 5, 15, 10, 0, 0) });
    const journal = await fx.t.run((ctx) => ctx.db.get(posted.journalEntryId));
    expect(journal).toMatchObject({ status: "POSTED", accountingDate: Date.UTC(2026, 5, 15, 10, 0, 0) });
  });

  test("the same command replayed with other expected figures is not silently accepted as the first", async () => {
    const { fx, bankB } = await seedLate();
    await post(fx, bankB);
    const after = await state(fx);
    const outcome = await codeOf(post(fx, bankB, { expectedAmountMinor: 999, expectedOpeningBalanceDate: NOW }));
    expect(outcome).toMatch(/^UNCODED:.*Idempotency key reused with different request content/);
    expect(await state(fx)).toEqual(after);
    // The same command with the same figures still returns the first result.
    expect((await post(fx, bankB)).journalEntryId).toBeDefined();
    expect(await state(fx)).toEqual(after);
  });
});
