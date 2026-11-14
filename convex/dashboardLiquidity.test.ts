import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { api } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.*s");

async function setup(deletedCount = 0) {
  const t = convexTestWithComponents(schema, modules);
  const { orgId, secondOrg } = await t.run(async (ctx) => {
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
      if (roleName === "MANAGER") {
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
          [orgId, "Deleted", true, false, true],
          [secondOrg, "Foreign", true, false, false],
        ] as const) {
          const bankAccountId = await ctx.db.insert("bankAccounts", {
            orgId: tenant, name, isActive, isReconciliationTarget, isDeleted, currency: "JOD",
            openingBalanceMinor: 999_000, openingBalanceDate: 0, createdBy: userId,
            iban: "private-reference", createdAt: 0, updatedAt: 0,
          });
          if (tenant === orgId && !isDeleted) {
            const debitMinor = name === "Primary" ? 182_500 : 94_021;
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
    return { orgId, secondOrg };
  });
  const balance = (role: string, tenant = orgId) =>
    t.withIdentity({ subject: role }).query(api.dashboardLiquidity.liquidity, { orgId: tenant });
  const inventory = (role: string) => t.withIdentity({ subject: role }).query(api.dashboardLiquidity.bankInventory, {
    orgId, paginationOpts: { numItems: 12, cursor: null },
  });
  return { balance, inventory, secondOrg };
}

describe("Dashboard cash and banks", () => {
  test("owners and managers see exact per-currency cash and every visible bank", async () => {
    const { balance, inventory } = await setup();
    const manager = await balance("MANAGER");
    expect(await balance("OWNER")).toEqual(manager);
    expect(manager?.cash).toEqual([
      { currency: "JOD", balanceMinor: 1_234_486 },
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

  test("lists visible banks even when historical rows exhaust the balance budget", async () => {
    const { inventory, balance } = await setup(251);
    expect((await inventory("MANAGER")).page.map((bank) => bank.name)).toEqual(["Primary", "Closed"]);
    expect((await balance("MANAGER"))?.banks).toEqual([]);
  });

  test("withholds figures from other roles and refuses another tenant", async () => {
    const { balance, inventory, secondOrg } = await setup();
    expect(await balance("SALES")).toBeNull();
    expect((await inventory("SALES")).page).toEqual([]);
    expect(await balance("RESTRICTED_MANAGER")).toBeNull();
    await expect(balance("MANAGER", secondOrg)).rejects.toThrow(/not a member/);
  });
});
