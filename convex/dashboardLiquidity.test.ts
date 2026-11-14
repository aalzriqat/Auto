import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTestWithComponents(schema, modules);
  const { orgId, secondOrg } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Dealer", createdAt: 0 });
    const secondOrg = await ctx.db.insert("organizations", { name: "Other dealer", createdAt: 0 });
    await ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    });
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
        for (const [tenant, name, isActive, isReconciliationTarget, isDeleted] of [
          [orgId, "Primary", true, true, false],
          [orgId, "Closed", false, false, false],
          [orgId, "Deleted", true, false, true],
          [secondOrg, "Foreign", true, false, false],
        ] as const) {
          await ctx.db.insert("bankAccounts", {
            orgId: tenant, name, isActive, isReconciliationTarget, isDeleted, currency: "JOD",
            openingBalanceMinor: 999_000, openingBalanceDate: 0, createdBy: userId,
            iban: "private-reference", createdAt: 0, updatedAt: 0,
          });
        }
      }
    }
    return { orgId, secondOrg };
  });
  const balance = (role: string, tenant = orgId) =>
    t.withIdentity({ subject: role }).query(api.dashboard.liquidity, { orgId: tenant });
  return { balance, secondOrg };
}

describe("Dashboard cash and banks", () => {
  test("owners and managers see exact per-currency cash and every visible bank", async () => {
    const { balance } = await setup();
    const manager = await balance("MANAGER");
    expect(await balance("OWNER")).toEqual(manager);
    expect(manager?.cash).toEqual([
      { currency: "JOD", balanceMinor: 1_234_486 },
      { currency: "USD", balanceMinor: -100 },
    ]);
    expect(manager?.banks).toEqual([
      expect.objectContaining({ name: "Closed", active: false, balanceMinor: null }),
      expect.objectContaining({ name: "Primary", active: true, balanceMinor: 0 }),
    ]);
    expect(Object.keys(manager?.banks?.[1] ?? {}).sort()).toEqual([
      "active", "balanceMinor", "currency", "id", "name",
    ]);
  });

  test("withholds figures from other roles and refuses another tenant", async () => {
    const { balance, secondOrg } = await setup();
    expect(await balance("SALES")).toBeNull();
    expect(await balance("RESTRICTED_MANAGER")).toBeNull();
    await expect(balance("MANAGER", secondOrg)).rejects.toThrow(/not a member/);
  });
});
