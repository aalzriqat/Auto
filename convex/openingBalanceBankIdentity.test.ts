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

async function postedLines(fx: Fx, journalId: string) {
  return fx.t.run((ctx) =>
    ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId as Id<"journalEntries">))
      .collect()
  );
}

const NO_SIDE_EFFECTS = { drafts: 0, entries: 0, lines: 0, snapshots: 0 };

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

    const { journalId } = await fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, {
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
      fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, {
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
        fx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, {
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
        fx.asAccountant.mutation(api.accountingCutover.approveOpeningBalance, { orgId: fx.orgId, draftId })
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
