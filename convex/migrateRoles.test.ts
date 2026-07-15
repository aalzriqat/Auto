import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.*s");

describe("backfillAccountantExpensePermissions", () => {
  test("adds CREATE_EXPENSES/EDIT_EXPENSES to a role with manage:finance", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Backfill Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "ACCOUNTANT",
        permissions: ["view:finance", "manage:finance"],
      })
    );

    const result = await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
    expect(result.updatedCount).toBe(1);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).toContain("create:expenses");
    expect(role?.permissions).toContain("edit:expenses");
  });

  test("leaves a role without manage:finance untouched", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Backfill Dealer 2", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:sales", "create:sales:request"] })
    );

    const result = await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
    expect(result.updatedCount).toBe(0);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).not.toContain("create:expenses");
  });

  test("is idempotent — a second run updates nothing further", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Backfill Dealer 3", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "ACCOUNTANT",
        permissions: ["view:finance", "manage:finance"],
      })
    );

    await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
    const second = await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
    expect(second.updatedCount).toBe(0);
  });

  test("an OWNER role gets the permissions even without manage:finance explicitly listed", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Backfill Dealer 4", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:org"] })
    );

    const result = await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
    expect(result.updatedCount).toBe(1);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).toContain("create:expenses");
    expect(role?.permissions).toContain("edit:expenses");
    // patchRoleIfNeeded also stamps the explicit ownership flag on any stale
    // OWNER-named row missing it — this backfill picking that up too is the
    // whole point of sharing that helper, not just this permission pair.
    expect(role?.isSystemOwnerRole).toBe(true);
  });
});

describe("backfillReopenPeriodsPermission", () => {
  test("adds REOPEN_PERIODS to a stale OWNER-named role missing the explicit flag", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Reopen Backfill Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:org"] })
    );

    const result = await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
    expect(result.updatedCount).toBe(1);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).toContain("reopen:accounting_periods");
    expect(role?.isSystemOwnerRole).toBe(true);
  });

  test("does NOT grant REOPEN_PERIODS to a MANAGE_FINANCE-holding non-owner role (ACCOUNTANT) — unlike the other capability-matched backfills, this one is owner-only by design", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Reopen Backfill Dealer 2", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance"] })
    );

    const result = await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
    expect(result.updatedCount).toBe(0);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).not.toContain("reopen:accounting_periods");
  });

  test("is idempotent — a second run updates nothing further", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Reopen Backfill Dealer 3", createdAt: Date.now() })
    );
    await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:org"] }));

    await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
    const second = await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
    expect(second.updatedCount).toBe(0);
  });

  test("leaves an already-flagged OWNER role holding the permission untouched", async () => {
    const t = convexTest(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Reopen Backfill Dealer 4", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "OWNER",
        permissions: ["view:org", "reopen:accounting_periods"],
        isSystemOwnerRole: true,
      })
    );

    const result = await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
    expect(result.updatedCount).toBe(0);

    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.permissions).toEqual(["view:org", "reopen:accounting_periods"]);
  });
});
