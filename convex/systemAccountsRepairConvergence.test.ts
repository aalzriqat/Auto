import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function setupOrgWithChart(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Test ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;

  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );

  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `user_${suffix}`, email: `${suffix}@test.com`, name: "Finance Admin" })
  )) as Id<"users">;

  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asAdmin = t.withIdentity({ subject: `user_${suffix}` });

  // Initialize standard chart
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  return { t, orgId, userId, asAdmin };
}

describe("System Account Repair Convergence & Invariant Proof (BLOCKER 6)", () => {
  test("1. Two repeated repair calls: first repairs missing key, second converges to empty repaired list with no duplicate rows", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("repeat_repair");

    // Remove one required system account: UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY (code 2110)
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

    // First call repairs it
    const first = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(first.repaired).toContain(SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY);

    // Verify row was created
    const createdRows = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .collect()
    );
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0].code).toBe("2110");

    // Second call must return empty repaired list and create no duplicate
    const second = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(second.repaired).toEqual([]);

    const rowsAfterSecond = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .collect()
    );
    expect(rowsAfterSecond).toHaveLength(1);
  });

  test("2. Concurrent-equivalent repair attempts: transactions converge on exactly one active system account", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("concurrent_repair");

    // Remove UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

    // In Convex OCC semantics, serializing two repair attempts:
    const [res1, res2] = await Promise.all([
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId }),
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId }),
    ]);

    // Exactly one call creates the account, the other observes the committed state
    const totalRepaired = [...res1.repaired, ...res2.repaired].filter(
      (k) => k === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );
    expect(totalRepaired).toHaveLength(1);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
  });

  test("3. Existing correct account: repair does not touch or duplicate existing accounts", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("existing_correct");

    const beforeRows = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );

    const result = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(result.repaired).toEqual([]);

    const afterRows = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(afterRows.length).toBe(beforeRows.length);
  });

  test("4. Inactive matching account: refuses repair instead of creating a duplicate or silently overwriting", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("inactive_account");

    // Deactivate an existing system account
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (account) await ctx.db.patch(account._id, { active: false });
    });

    // Repair MUST throw ConvexError and refuse
    await expect(
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId })
    ).rejects.toThrow(/mapped only to an inactive account/i);

    // Database still has exactly one row, still inactive
    const rows = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
  });

  test("5. Custom account occupying reserved code: refuses repair rather than stealing code or creating duplicate code", async () => {
    const { t, orgId, asAdmin, userId } = await setupOrgWithChart("custom_code_conflict");

    // Delete UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY (code 2110) and replace with an unmapped custom account on code 2110
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);

      await ctx.db.insert("chartOfAccounts", {
        orgId,
        code: "2110",
        name: "Custom Unmapped Liability",
        nameAr: "التزام غير معين",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        isControlAccount: false,
        allowManualPosting: true,
        active: true,
        createdAt: Date.now(),
        createdBy: userId,
        updatedAt: Date.now(),
        updatedBy: userId,
      });
    });

    // Repair should refuse because code 2110 is occupied by a custom account needing explicit decision
    await expect(
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId })
    ).rejects.toThrow(/needs an explicit mapping decision/i);
  });

  test("6. Conflicting systemKey: account on reserved code belongs to different system key, repair refuses", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("system_key_conflict");

    // Delete UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY (2110) and patch another system account to code 2110
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);

      // Take another system account (CUSTOMER_DEPOSITS_LIABILITY 2100) and change its code to 2110
      const otherRow = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY))
        .unique();
      if (otherRow) {
        await ctx.db.patch(otherRow._id, { code: "2110" });
      }
    });

    await expect(
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId })
    ).rejects.toThrow(/Chart of accounts conflict: code 2110 is already/i);
  });

  test("7. Duplicate active systemKey reconciliation: converges to exactly one authoritative active mapping", async () => {
    const { t, orgId, asAdmin, userId } = await setupOrgWithChart("historical_duplicates");

    // Insert a duplicate active row with the same systemKey (simulating pre-existing corrupted data)
    const dupId = await t.run(async (ctx) => {
      return await ctx.db.insert("chartOfAccounts", {
        orgId,
        code: "2110-DUP",
        name: "Unapplied Receipts Duplicate",
        nameAr: "مقبوضات مكررة",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        isControlAccount: true,
        allowManualPosting: false,
        active: true,
        systemKey: SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY,
        createdAt: Date.now(),
        createdBy: userId,
        updatedAt: Date.now(),
        updatedBy: userId,
      });
    });

    // Before repair: 2 active mappings exist, violating the single active mapping invariant
    const beforeRows = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) =>
          q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
        )
        .collect()
    );
    expect(beforeRows).toHaveLength(2);

    // Calling repair executes explicit reconciliation:
    // It identifies the duplicate active mapping, preserves the oldest authoritative account (code 2110),
    // and clears systemKey from the duplicate row so exactly one active mapping remains.
    const result = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(result.reconciled).toContain(SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY);

    // Invariant holds: exactly ONE active mapping now exists for the systemKey
    const rows = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) =>
          q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("2110");
    expect(rows[0].active).toBe(true);

    // The duplicate row was unmapped (systemKey cleared) rather than left as a second active system key
    const dupRow = await t.run((ctx) => ctx.db.get(dupId));
    expect(dupRow?.systemKey).toBeUndefined();

    // Verification via validateSystemAccounts confirms the chart is fully valid with 0 missing accounts
    const validation = await asAdmin.query(api.chartOfAccounts.validateSystemAccounts, { orgId });
    expect(validation.valid).toBe(true);
    expect(validation.missing).toEqual([]);
  });

  test("8. Rerunning repair after success: remains stable and idempotent across multiple runs", async () => {
    const { t, orgId, asAdmin } = await setupOrgWithChart("rerun_after_success");

    // Delete UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

    const run1 = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(run1.repaired).toContain(SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY);

    const run2 = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(run2.repaired).toEqual([]);

    const run3 = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(run3.repaired).toEqual([]);
  });

  test("9. Rerunning after a refused/conflict result: succeeds once conflict is explicitly resolved", async () => {
    const { t, orgId, asAdmin, userId } = await setupOrgWithChart("rerun_after_conflict_resolved");

    // Step A: Create a conflict on UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY (2110)
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique();
      if (row) await ctx.db.delete(row._id);

      await ctx.db.insert("chartOfAccounts", {
        orgId,
        code: "2110",
        name: "Pre-existing Unmapped Liability",
        nameAr: "حساب التزام قائم",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        isControlAccount: false,
        allowManualPosting: true,
        active: true,
        createdAt: Date.now(),
        createdBy: userId,
        updatedAt: Date.now(),
        updatedBy: userId,
      });
    });

    // Step B: Repair initially refuses
    await expect(
      asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId })
    ).rejects.toThrow(/needs an explicit mapping decision/i);

    // Step C: Explicitly adopt the candidate account via confirmSystemAccountAdoption
    await asAdmin.mutation(api.chartOfAccounts.confirmSystemAccountAdoption, {
      orgId,
      systemKey: SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY,
      decision: "ADOPT",
    });

    // Step D: Rerun repair — now it succeeds cleanly with nothing missing
    const rerun = await asAdmin.mutation(api.chartOfAccounts.repairMissingSystemAccounts, { orgId });
    expect(rerun.repaired).toEqual([]);

    // The account now has the system key and is active
    const adopted = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY))
        .unique()
    );
    expect(adopted?.code).toBe("2110");
    expect(adopted?.active).toBe(true);
    expect(adopted?.isControlAccount).toBe(true);
  });
});
