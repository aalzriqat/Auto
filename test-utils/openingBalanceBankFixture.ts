import { convexTestWithComponents } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const MODULE_GLOB = import.meta.glob("../convex/**/*.*s");

// Retained earnings is a synthetic test offset only; it classifies no real guide amount.
export async function seedBankOpeningFixture() {
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

  return { t, orgId, ownerId, accountantId, asOwner, asAccountant, bankControlId, syntheticOffsetId, cashId, createBank };
}

export type BankOpeningFixture = Awaited<ReturnType<typeof seedBankOpeningFixture>>;

export function bankOpening(fx: BankOpeningFixture, bankAccountId?: Id<"bankAccounts">, amount = 1_000_000) {
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

export async function sideEffects(fx: BankOpeningFixture) {
  return fx.t.run(async (ctx) => ({
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
    entries: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    snapshots: (await ctx.db.query("accountBalanceSnapshots").collect()).length,
  }));
}

export async function postedLines(fx: BankOpeningFixture, journalId: Id<"journalEntries"> | string) {
  return fx.t.run((ctx) =>
    ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId as Id<"journalEntries">))
      .collect()
  );
}

export const NO_SIDE_EFFECTS = { drafts: 0, entries: 0, lines: 0, snapshots: 0 };
