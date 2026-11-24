import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.*s");

async function setup(deletedCount = 0, deletedBalance = 0, registry: "present" | "empty" = "present") {
  const t = convexTestWithComponents(schema, modules);
  const { orgId, secondOrg, now } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Dealer", createdAt: 0 });
    const secondOrg = await ctx.db.insert("organizations", { name: "Other dealer", createdAt: 0 });
    await ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    });
    const now = Date.now();
    const periodId = await ctx.db.insert("accountingPeriods", {
      orgId, startDate: 0, endDate: 60_000, fiscalYear: 1970, periodNumber: 1,
      status: "CLOSED", createdAt: 0,
    });
    for (const [code, systemKey] of [["1000", "CASH_ON_HAND"], ["1010", "BANK_ACCOUNT"]]) {
      const accountId = await ctx.db.insert("chartOfAccounts", {
        orgId, code, systemKey, name: systemKey, type: "ASSET", normalBalance: "DEBIT",
        active: true, isControlAccount: true, allowManualPosting: false, createdAt: 0, updatedAt: 0,
      });
      if (systemKey === "CASH_ON_HAND") {
        await ctx.db.insert("accountBalanceSnapshots", {
          orgId, accountId, periodId, currency: "JOD",
          runningDebitMinor: 1_234_567, runningCreditMinor: 81, updatedAt: 0,
        });
        await ctx.db.insert("accountBalanceSnapshots", {
          orgId, accountId, periodId, currency: "USD",
          runningDebitMinor: 200, runningCreditMinor: 300, updatedAt: 0,
        });
      }
    }
    const currentPeriod = await ctx.db.insert("accountingPeriods", {
      orgId, startDate: now - 60_000, endDate: now + 60_000, fiscalYear: 2026, periodNumber: 2,
      status: "OPEN", createdAt: now,
    });
    const control = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT")).unique();
    if (!control) throw new Error("Missing bank control in test fixture");
    for (const roleName of ["MANAGER", "OWNER", "SALES", "RESTRICTED_MANAGER"]) {
      const userId = await ctx.db.insert("users", {
        clerkId: roleName, email: `${roleName}@example.test`, name: roleName,
      });
      const roleId = await ctx.db.insert("roles", {
        orgId, name: roleName === "RESTRICTED_MANAGER" ? "MANAGER" : roleName,
        permissions: roleName === "RESTRICTED_MANAGER" ? [] : [PERMISSIONS.VIEW_REPORTS],
        ...(roleName === "OWNER" ? { isSystemOwnerRole: true } : {}),
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      if (roleName === "MANAGER" && registry === "present") {
        for (let index = 0; index < deletedCount; index++) {
          await ctx.db.insert("bankAccounts", {
            orgId, name: "Historical", currency: "JOD", isActive: false, isReconciliationTarget: false,
            isDeleted: true, openingBalanceMinor: 0, openingBalanceDate: 0,
            createdBy: userId, createdAt: 0, updatedAt: 0,
          });
        }

        for (const [tenant, name, isActive, isReconciliationTarget, isDeleted] of [
          [orgId, "Primary", true, true, false],
          [orgId, "Closed", false, false, false],
          [orgId, "Deleted", false, false, true],
          [secondOrg, "Foreign", true, false, false],
        ] as const) {
          const bankAccountId = await ctx.db.insert("bankAccounts", {
            orgId: tenant, name, isActive, isReconciliationTarget, isDeleted, currency: "JOD",
            openingBalanceMinor: 999_000, openingBalanceDate: 0, createdBy: userId,
            iban: "private-reference", createdAt: 0, updatedAt: 0,
          });
          if (tenant === orgId && (!isDeleted || deletedBalance !== 0)) {
            const debitMinor = isDeleted ? deletedBalance : name === "Primary" ? 182_500 : 94_021;
            const journalEntryId = await ctx.db.insert("journalEntries", {
              orgId, periodId: currentPeriod, journalNumber: name, accountingDate: now,
              sourceType: "test", sourceId: name, category: "SYSTEM", memo: "bank fixture",
              status: "POSTED", currency: "JOD", postedBy: userId, postedAt: now, createdAt: now,
            });
            await ctx.db.insert("journalLines", {
              orgId, journalEntryId, lineNumber: 1, accountId: control._id, bankAccountId,
              currency: "JOD", scale: 3, accountingDate: now, debitMinor, creditMinor: 0,
            });
            await incrementAccountSnapshot(ctx, {
              orgId, accountId: control._id, currency: "JOD", periodId: currentPeriod,
              debitMinor, creditMinor: 0,
            });
          }
        }
      }
    }
    return { orgId, secondOrg, now };
  });
  const balance = (role: string, tenant = orgId, asOf?: number) =>
    t.withIdentity({ subject: role }).query(api.dashboardLiquidity.liquidity, { orgId: tenant, asOf });
  const inventory = (role: string, tenant = orgId) => t.withIdentity({ subject: role }).query(api.dashboardLiquidity.bankInventory, {
    orgId: tenant, paginationOpts: { numItems: 12, cursor: null },
  });
  const bankPage = (role: string, bankIds: Id<"bankAccounts">[], asOf = now) =>
    t.withIdentity({ subject: role }).query(api.dashboardLiquidity.bankBalancesForPage, { orgId, bankIds, asOf });
  return { t, balance, inventory, bankPage, secondOrg, now, orgId };
}

describe("Dashboard cash and banks", () => {
  test("owners and managers see exact totals including funds still attributed to a removed bank", async () => {
    const { balance, inventory } = await setup(0, 126_400);
    const manager = await balance("MANAGER");
    expect(await balance("OWNER")).toEqual(manager);
    expect(manager?.cash).toEqual([
      { currency: "JOD", balanceMinor: 1_234_486 },
      { currency: "USD", balanceMinor: -100 },
    ]);
    expect(manager?.bankTotals).toEqual([{ currency: "JOD", balanceMinor: 402_921 }]);
    expect(manager?.cashAndBankTotals).toEqual([
      { currency: "JOD", balanceMinor: 1_637_407 },
      { currency: "USD", balanceMinor: -100 },
    ]);
    const managerInventory = await inventory("MANAGER");
    expect(await inventory("OWNER")).toEqual(managerInventory);
    const amounts = new Map(manager?.banks?.map((bank) => [bank.id, bank.balanceMinor]));
    expect(managerInventory.page.map((bank) => [bank.name, bank.active, amounts.get(bank.id)])).toEqual([
      ["Primary", true, 182_500],
      ["Closed", false, 94_021],
    ]);
    expect(Object.keys(managerInventory.page[0]).sort()).toEqual(["active", "currency", "id", "name"]);
  });

  test("owners and managers recover visible balances when historical accounts exceed the full-read bound", async () => {
    const { inventory, balance, bankPage, now } = await setup(251);
    const { page } = await inventory("MANAGER");
    expect(page.map(bank => bank.name)).toEqual(["Primary", "Closed"]);
    const figures = await balance("MANAGER");
    expect(figures?.banks).toEqual([]);
    expect(figures?.bankTotals).toEqual([{ currency: "JOD", balanceMinor: null }]);
    expect(figures?.cashAndBankTotals).toEqual([
      { currency: "JOD", balanceMinor: null },
      { currency: "USD", balanceMinor: -100 },
    ]);
    const bankIds = page.map(bank => bank.id);
    const amounts = [
      { id: bankIds[0], balanceMinor: 182_500 },
      { id: bankIds[1], balanceMinor: 94_021 },
    ];
    expect(await bankPage("MANAGER", bankIds)).toEqual(amounts);
    expect(await bankPage("OWNER", bankIds)).toEqual(amounts);
    expect(await bankPage("MANAGER", bankIds, now - 1)).toEqual(
      bankIds.map(id => ({ id, balanceMinor: 0 })),
    );
  });

  test.each([
    ["present", "open"], ["empty", "open"], ["present", "closed"], ["empty", "closed"],
  ] as const)("unattributed bank activity with %s bank records and a %s period never reads as zero", async (registry, periodState) => {
    const { t, orgId, now, balance } = await setup(0, 0, registry);
    if (registry === "empty") {
      expect((await balance("OWNER"))?.bankTotals).toEqual([]);
    }
    await t.runUnwrapped(async ctx => {
      const account = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q =>
        q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT")).unique();
      const startDate = periodState === "closed" ? 0 : now - 60_000;
      const accountingDate = periodState === "closed" ? 0 : now;
      const period = await ctx.db.query("accountingPeriods").withIndex("by_org_startDate", q =>
        q.eq("orgId", orgId).eq("startDate", startDate)).unique();
      const user = await ctx.db.query("users").withIndex("by_clerkId", q => q.eq("clerkId", "OWNER")).unique();
      if (!account || !period || !user) throw new Error("Expected a ledger and an authenticated actor");
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId, periodId: period._id, journalNumber: "LEGACY-USD", accountingDate,
        sourceType: "test", sourceId: "legacy-bank", category: "SYSTEM", memo: "Pre-attribution bank history",
        status: "POSTED", currency: "USD", postedBy: user._id, postedAt: now, createdAt: now,
      });
      for (const [lineNumber, debitMinor, creditMinor] of [[1, 500, 0], [2, 0, 500]]) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId, lineNumber, accountId: account._id, currency: "USD", scale: 2,
          accountingDate, debitMinor, creditMinor,
        });
      }
    });
    const totals = await balance("OWNER");
    expect(totals?.bankTotals).toContainEqual({ currency: "USD", balanceMinor: null });
    expect(totals?.cashAndBankTotals).toContainEqual({ currency: "USD", balanceMinor: null });
    expect(totals?.cash).toContainEqual({ currency: "USD", balanceMinor: -100 });
  });

  test("the paged read refuses a foreign bank and is unavailable to unauthorized roles", async () => {
    const { t, inventory, bankPage, secondOrg } = await setup();
    const { page } = await inventory("MANAGER");
    const remote = await t.run(ctx => ctx.db.query("bankAccounts").withIndex("by_org", q =>
      q.eq("orgId", secondOrg)).unique());
    if (!remote) throw new Error("Missing other tenant's bank");
    await expect(bankPage("MANAGER", [page[0].id, remote._id])).rejects.toThrow(/not found in this organization/i);
    expect(await bankPage("SALES", [page[0].id])).toEqual([]);
    expect(await bankPage("RESTRICTED_MANAGER", [page[0].id])).toEqual([]);
    await expect(bankPage("OWNER", Array.from({ length: 13 }, () => page[0].id))).rejects.toThrow(/up to 12/i);
  });

  test("the paged read checks each elapsed period even when snapshot errors cancel in the total", async () => {
    const { t, orgId, inventory, bankPage } = await setup(251);
    const { page } = await inventory("OWNER");
    await t.run(async ctx => {
      const account = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q =>
        q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT")).unique();
      const closed = await ctx.db.query("accountingPeriods").withIndex("by_org_startDate", q =>
        q.eq("orgId", orgId).eq("startDate", 0)).unique();
      if (!account || !closed) throw new Error("Missing bank control or closed period");
      await ctx.db.insert("accountBalanceSnapshots", {
        orgId, accountId: account._id, periodId: closed._id, currency: "JOD",
        runningDebitMinor: 1, runningCreditMinor: 0, updatedAt: 0,
      });
      const nextClosed = await ctx.db.insert("accountingPeriods", {
        orgId, startDate: 60_001, endDate: 120_000, fiscalYear: 1970,
        periodNumber: 2, status: "CLOSED", createdAt: 0,
      });
      await ctx.db.insert("accountBalanceSnapshots", {
        orgId, accountId: account._id, periodId: nextClosed, currency: "JOD",
        runningDebitMinor: 0, runningCreditMinor: 1, updatedAt: 0,
      });
    });
    expect(await bankPage("OWNER", page.map(bank => bank.id))).toEqual([]);
  });

  test("crossing a posted bank line's date refreshes balances without a write", async () => {
    const { balance, now, orgId } = await setup();
    expect((await balance("MANAGER", orgId, now - 1))?.banks?.map((bank) => bank.balanceMinor)).toEqual([0, 0]);
    expect((await balance("MANAGER", orgId, now))?.banks?.map((bank) => bank.balanceMinor)).toEqual([182_500, 94_021]);
  });

  test("withholds figures from other roles and refuses another tenant", async () => {
    const { balance, inventory, secondOrg } = await setup();
    expect(await balance("SALES")).toBeNull();
    expect((await inventory("SALES")).page).toEqual([]);
    expect(await balance("RESTRICTED_MANAGER")).toBeNull();
    await expect(balance("MANAGER", secondOrg)).rejects.toThrow(/not a member/);
    await expect(inventory("MANAGER", secondOrg)).rejects.toThrow(/not a member/);
  });
});
