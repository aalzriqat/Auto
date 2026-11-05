import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const backfill = internal.migrateRoles.backfillAccountantCommissionsAccess;
const marker = "accountant-commissions-2026-11-04";
// Frozen pre-grant fixture: a future template change must not change this cohort.
const legacyPermissions = () => [
  "view:org", "view:users", "view:vehicles", "view:vehicle_info", "view:vehicle_expenses",
  "view:customers", "view:sales", "view:expenses", "create:expenses", "edit:expenses",
  "view:reports", "view:finance", "manage:finance", "view:finance_applications",
  "confirm:finance_disbursement", "manage:supplier_settlement", "view:cost_price",
  "view:payroll", "manage:payroll",
];

test("SCRUM-908: exact production-shaped ACCOUNTANT receives commissions and a marker once", async () => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Legacy Dealer", createdAt: 1 }));
  const before = legacyPermissions();
  expect(before).toHaveLength(19);
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: before }));
  expect((await t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {})).updatedCount).toBe(0);
  const first = await t.mutation(backfill, {});
  expect(first).toEqual({ updatedCount: 1, updates: [expect.any(String)], isDone: true, continueCursor: expect.any(String) });
  const once = await t.run((ctx) => ctx.db.get(roleId));
  expect(once?.permissions).toEqual([...before, "view:commissions"]);
  expect(once).toMatchObject({ appliedRoleMigrations: ["accountant-commissions-2026-11-04"] });
  const second = await t.mutation(backfill, {});
  expect(second.updatedCount).toBe(0);
  expect(second.updates).toEqual([]);
  expect(await t.run((ctx) => ctx.db.get(roleId))).toEqual(once);
  await t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.permissions).toEqual([...before, "view:commissions"]);
});

test.each(["create:sales", "confirm:finance_disbursement"])("SCRUM-908: custom ACCOUNTANT with only %s is untouched", async (permission) => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Normalized Dealer", createdAt: 1 }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: " Accountant ", permissions: [permission] }));
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.permissions).toEqual([permission]);
});

test("SCRUM-908: exact-template backfill leaves extra, missing, duplicate, renamed, deleted and system-owner roles unchanged", async () => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Excluded Dealer", createdAt: 1 }));
  const ids = await t.run(async (ctx) => {
    const rows = [
      { name: "Bookkeeper", permissions: legacyPermissions() },
      { name: "CUSTOM", permissions: legacyPermissions() },
      { name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance"] },
      { name: "ACCOUNTANT", permissions: legacyPermissions(), isDeleted: true },
      { name: "ACCOUNTANT", permissions: [...legacyPermissions(), "manage:commissions"] },
      { name: "ACCOUNTANT", permissions: legacyPermissions().filter((p) => p !== "view:payroll") },
      { name: "ACCOUNTANT", permissions: legacyPermissions().map((p) => p === "view:payroll" ? "manage:commissions" : p) },
      { name: "ACCOUNTANT", permissions: [...legacyPermissions(), "view:users"] },
      { name: "ACCOUNTANT", permissions: legacyPermissions().filter((p) => p !== "view:cost_price") },
      { name: "ACCOUNTANT", permissions: legacyPermissions(), isSystemOwnerRole: true },
      { name: "OWNER", permissions: legacyPermissions(), isSystemOwnerRole: true },
      { name: "ACCOUNTANT", permissions: [...legacyPermissions(), "view:commissions"] },
    ];
    const inserted = [];
    for (const row of rows) inserted.push(await ctx.db.insert("roles", { orgId, ...row }));
    return inserted;
  });
  const before = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect(await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))))).toEqual(before);
});

test("SCRUM-908: commission backfill respects an owner's public rename, recreation and later restriction", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "commission_backfill_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Owner Choices Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "Renamed Accountant" });
  const customPermissions = [...legacyPermissions(), "manage:commissions"];
  const customId = await owner.mutation(api.roles.create, { orgId, name: "ACCOUNTANT", permissions: customPermissions });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await owner.query(api.roles.get, { orgId, roleId: customId })).permissions).toEqual(customPermissions);

  await owner.mutation(api.roles.remove, { orgId, roleId: customId });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "ACCOUNTANT" });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, permissions: customPermissions });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await owner.query(api.roles.get, { orgId, roleId: seeded._id })).permissions).toEqual(customPermissions);
});

test("SCRUM-908: a completed migration never widens an exact-19 ACCOUNTANT recreated by its owner", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "recreated_accountant_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Recreated Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  expect((await t.mutation(backfill, {})).isDone).toBe(true);
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "Former Accountant" });
  const roleId = await owner.mutation(api.roles.create, { orgId, name: "ACCOUNTANT", permissions: legacyPermissions() });
  const before = await owner.query(api.roles.get, { orgId, roleId });
  expect(before.permissions).toHaveLength(19);

  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  const after = await owner.query(api.roles.get, { orgId, roleId });
  expect(after.permissions).not.toContain("view:commissions");
  expect(after).toEqual(before);
});

test("SCRUM-908: a completed migration never widens an exact-19 Bookkeeper renamed accountant by its owner", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "renamed_bookkeeper_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Renamed Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  expect((await t.mutation(backfill, {})).isDone).toBe(true);
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "Former Accountant" });
  const roleId = await owner.mutation(api.roles.create, { orgId, name: "Bookkeeper", permissions: legacyPermissions() });
  await owner.mutation(api.roles.update, { orgId, roleId, name: "accountant" });
  const before = await owner.query(api.roles.get, { orgId, roleId });
  expect(before.permissions).toHaveLength(19);

  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  const after = await owner.query(api.roles.get, { orgId, roleId });
  expect(after.permissions).not.toContain("view:commissions");
  expect(after).toEqual(before);
});

test("SCRUM-908: only the final commission page records completion and later runs leave roles unchanged", async () => {
  const t = convexTestWithComponents(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "One Shot Dealer", createdAt: 1 });
    return Promise.all(["ACCOUNTANT", "accountant"].map((name) =>
      ctx.db.insert("roles", { orgId, name, permissions: legacyPermissions() })));
  });
  const first = await t.mutation(backfill, { numItems: 1 });
  expect(first).toMatchObject({ updatedCount: 1, isDone: false });
  expect(await t.run((ctx) => ctx.db.query("roleMigrationRuns").collect())).toEqual([]);
  const last = await t.mutation(backfill, { numItems: 1, cursor: first.continueCursor });
  expect(last).toMatchObject({ updatedCount: 1, isDone: true });
  const completed = await t.run((ctx) => ctx.db.query("roleMigrationRuns").collect());
  expect(completed).toEqual([expect.objectContaining({ migration: "accountant-commissions-2026-11-04", completedAt: expect.any(Number) })]);
  await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.patch(id, { permissions: legacyPermissions(), appliedRoleMigrations: undefined }))));
  const before = await t.run((ctx) => ctx.db.query("roles").collect());

  expect(await t.mutation(backfill, {})).toEqual({ updatedCount: 0, updates: [], isDone: true, continueCursor: "" });
  // A completed run must not paginate roles, even with an unusable role cursor.
  expect(await t.mutation(backfill, { cursor: "not-a-role-cursor" })).toEqual({
    updatedCount: 0, updates: [], isDone: true, continueCursor: "not-a-role-cursor",
  });
  expect(await t.run((ctx) => ctx.db.query("roles").collect())).toEqual(before);
  expect(await t.run((ctx) => ctx.db.query("roleMigrationRuns").collect())).toEqual(completed);
});

test("SCRUM-908: one-role commission pages resume through both tenants without changing their role ownership", async () => {
  const t = convexTestWithComponents(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgA = await ctx.db.insert("organizations", { name: "Tenant A", createdAt: 1 });
    const orgB = await ctx.db.insert("organizations", { name: "Tenant B", createdAt: 1 });
    const a = await ctx.db.insert("roles", { orgId: orgA, name: "ACCOUNTANT", permissions: legacyPermissions() });
    const b = await ctx.db.insert("roles", { orgId: orgB, name: "ACCOUNTANT", permissions: legacyPermissions() });
    const custom = await ctx.db.insert("roles", { orgId: orgB, name: "Foreign Custom", permissions: ["create:sales"] });
    return { orgA, orgB, a, b, custom };
  });
  let cursor: string | null = null;
  let total = 0;
  let done = false;
  let calls = 0;
  for (let pageNumber = 0; pageNumber < 5 && !done; pageNumber += 1) {
    const page: { updatedCount: number; updates: string[]; isDone: boolean; continueCursor: string } = await t.mutation(backfill, { numItems: 1, cursor });
    expect(page.updatedCount).toBeLessThanOrEqual(1);
    expect(page.updates).toHaveLength(page.updatedCount);
    total += page.updatedCount;
    calls += 1;
    cursor = page.continueCursor;
    done = page.isDone;
  }
  expect(done).toBe(true);
  expect(calls).toBe(3);
  expect(total).toBe(2);
  expect(await t.run((ctx) => ctx.db.get(ids.a))).toMatchObject({ orgId: ids.orgA, permissions: [...legacyPermissions(), "view:commissions"] });
  expect(await t.run((ctx) => ctx.db.get(ids.b))).toMatchObject({ orgId: ids.orgB, permissions: [...legacyPermissions(), "view:commissions"] });
  expect(await t.run((ctx) => ctx.db.get(ids.custom))).toMatchObject({ orgId: ids.orgB, permissions: ["create:sales"] });
});

test("SCRUM-908: commission page size clamps at 500 roles and the saved cursor finishes the remainder", async () => {
  const t = convexTestWithComponents(schema, modules);
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Bounded Dealer", createdAt: 1 });
    for (let index = 0; index < 501; index += 1) {
      await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: legacyPermissions() });
    }
  });
  const first = await t.mutation(backfill, { numItems: 10_000 });
  expect(first.updatedCount).toBe(500);
  expect(first.isDone).toBe(false);
  const last = await t.mutation(backfill, { numItems: 0, cursor: first.continueCursor });
  expect(last.updatedCount).toBe(1);
  expect(last.isDone).toBe(true);
});

test("SCRUM-908: reordered exact template preserves unrelated migration markers", async () => {
  const t = convexTestWithComponents(schema, modules);
  const roleId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Reordered Dealer", createdAt: 1 });
    return ctx.db.insert("roles", { orgId, name: " Accountant ", permissions: legacyPermissions().reverse(), appliedRoleMigrations: ["other-migration"] });
  });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(1);
  expect(await t.run((ctx) => ctx.db.get(roleId))).toMatchObject({
    permissions: [...legacyPermissions().reverse(), "view:commissions"], appliedRoleMigrations: ["other-migration", marker],
  });
});

test("SCRUM-908: public role-save preserves the marker and later commission removal is not re-granted", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "marked_accountant_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Marker Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  // Historical unmarked role; new organizations exercise their own provenance below.
  await t.run((ctx) => ctx.db.patch(seeded._id, { permissions: legacyPermissions(), appliedRoleMigrations: undefined }));
  expect((await t.mutation(backfill, {})).updatedCount).toBe(1);
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "ACCOUNTANT", permissions: [...legacyPermissions(), "view:commissions"] });
  expect(await owner.query(api.roles.get, { orgId, roleId: seeded._id })).toMatchObject({ appliedRoleMigrations: [marker] });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, permissions: legacyPermissions() });
  const restricted = await owner.query(api.roles.get, { orgId, roleId: seeded._id });
  expect(restricted).toMatchObject({ permissions: legacyPermissions(), appliedRoleMigrations: [marker] });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await owner.query(api.roles.list, { orgId })).find((role) => role._id === seeded._id)).toEqual(restricted);
});

test("SCRUM-908: newly seeded ACCOUNTANT provenance protects a later owner restriction", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "new_accountant_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "New Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  expect(seeded).toMatchObject({ appliedRoleMigrations: [marker] });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, permissions: legacyPermissions() });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect(await owner.query(api.roles.get, { orgId, roleId: seeded._id })).toMatchObject({ permissions: legacyPermissions(), appliedRoleMigrations: [marker] });
});

test("SCRUM-908: role backfills and template sync preserve commission provenance", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "sync_accountant_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Sync Dealer" });
  const seeded = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!seeded) throw new Error("ACCOUNTANT was not seeded");
  await t.run((ctx) => ctx.db.patch(seeded._id, { permissions: legacyPermissions(), appliedRoleMigrations: undefined }));
  expect((await t.mutation(backfill, {})).updatedCount).toBe(1);
  await t.mutation(internal.migrateRoles.fixExistingRoles, {});
  await t.mutation(internal.migrateRoles.backfillFinanceApplicationPermissions, {});
  await t.mutation(internal.migrateRoles.backfillReopenPeriodsPermission, {});
  await t.mutation(internal.migrateRoles.backfillMarketplacePermissions, {});
  await t.mutation(internal.migrateRoles.backfillAccountantExpensePermissions, {});
  await t.mutation(internal.migrateRoles.backfillPayrollPermissions, {});
  await t.mutation(internal.migrateRoles.backfillVehicleValuationPermissions, {});
  await t.mutation(internal.migrateRoles.backfillSeniorAccountantRole, {});
  await t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
  await owner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId });
  expect(await owner.query(api.roles.get, { orgId, roleId: seeded._id })).toMatchObject({ appliedRoleMigrations: [marker] });
});
