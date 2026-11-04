import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");
const backfill = internal.migrateRoles.backfillAccountantCommissionsAccess;
const legacyPermissions = () => {
  const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "ACCOUNTANT");
  if (!template) throw new Error("ACCOUNTANT template is missing");
  return template.permissions.filter((permission) => permission !== PERMISSIONS.VIEW_COST_PRICE && permission !== PERMISSIONS.VIEW_COMMISSIONS);
};

test("SCRUM-908: commission backfill adds only once to the legacy ACCOUNTANT before cost repair", async () => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Legacy Dealer", createdAt: 1 }));
  const before = legacyPermissions();
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: before }));
  const first = await t.mutation(backfill, {});
  expect(first).toEqual({ updatedCount: 1, updates: [expect.any(String)], isDone: true, continueCursor: expect.any(String) });
  const once = await t.run((ctx) => ctx.db.get(roleId));
  expect(once?.permissions).toEqual([...before, "view:commissions"]);
  const second = await t.mutation(backfill, {});
  expect(second.updatedCount).toBe(0);
  expect(second.updates).toEqual([]);
  expect(await t.run((ctx) => ctx.db.get(roleId))).toEqual(once);
  await t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.permissions).toEqual([...before, "view:commissions", "view:cost_price"]);
});

test.each(["create:sales", "confirm:finance_disbursement"])("SCRUM-908: normalized ACCOUNTANT with %s and no cost access receives commissions", async (permission) => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Normalized Dealer", createdAt: 1 }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: " Accountant ", permissions: [permission] }));
  expect((await t.mutation(backfill, {})).updatedCount).toBe(1);
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.permissions).toEqual([permission, "view:commissions"]);
});

test("SCRUM-908: commission backfill leaves renamed, custom, restricted, deleted, cost-repaired and already-granted roles unchanged", async () => {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Excluded Dealer", createdAt: 1 }));
  const ids = await t.run(async (ctx) => {
    const rows = [
      { name: "Bookkeeper", permissions: legacyPermissions() },
      { name: "CUSTOM", permissions: legacyPermissions() },
      { name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance"] },
      { name: "ACCOUNTANT", permissions: legacyPermissions(), isDeleted: true },
      { name: "ACCOUNTANT", permissions: [...legacyPermissions(), "view:cost_price"] },
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
  const customPermissions = [...legacyPermissions(), "view:cost_price"];
  const customId = await owner.mutation(api.roles.create, { orgId, name: "ACCOUNTANT", permissions: customPermissions });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await owner.query(api.roles.get, { orgId, roleId: customId })).permissions).toEqual(customPermissions);

  await owner.mutation(api.roles.remove, { orgId, roleId: customId });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, name: "ACCOUNTANT" });
  await owner.mutation(api.roles.update, { orgId, roleId: seeded._id, permissions: customPermissions });
  expect((await t.mutation(backfill, {})).updatedCount).toBe(0);
  expect((await owner.query(api.roles.get, { orgId, roleId: seeded._id })).permissions).toEqual(customPermissions);
});

test("SCRUM-908: one-role commission pages resume through both tenants without changing their role ownership", async () => {
  const t = convexTestWithComponents(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgA = await ctx.db.insert("organizations", { name: "Tenant A", createdAt: 1 });
    const orgB = await ctx.db.insert("organizations", { name: "Tenant B", createdAt: 1 });
    const a = await ctx.db.insert("roles", { orgId: orgA, name: "ACCOUNTANT", permissions: legacyPermissions() });
    const b = await ctx.db.insert("roles", { orgId: orgB, name: "ACCOUNTANT", permissions: ["create:sales"] });
    const custom = await ctx.db.insert("roles", { orgId: orgB, name: "Foreign Custom", permissions: ["create:sales"] });
    return { orgA, orgB, a, b, custom };
  });
  let cursor: string | null = null;
  let total = 0;
  let done = false;
  for (let pageNumber = 0; pageNumber < 5 && !done; pageNumber += 1) {
    const page: { updatedCount: number; updates: string[]; isDone: boolean; continueCursor: string } = await t.mutation(backfill, { numItems: 1, cursor });
    expect(page.updatedCount).toBeLessThanOrEqual(1);
    expect(page.updates).toHaveLength(page.updatedCount);
    total += page.updatedCount;
    cursor = page.continueCursor;
    done = page.isDone;
  }
  expect(done).toBe(true);
  expect(total).toBe(2);
  expect(await t.run((ctx) => ctx.db.get(ids.a))).toMatchObject({ orgId: ids.orgA, permissions: [...legacyPermissions(), "view:commissions"] });
  expect(await t.run((ctx) => ctx.db.get(ids.b))).toMatchObject({ orgId: ids.orgB, permissions: ["create:sales", "view:commissions"] });
  expect(await t.run((ctx) => ctx.db.get(ids.custom))).toMatchObject({ orgId: ids.orgB, permissions: ["create:sales"] });
});

test("SCRUM-908: commission page size clamps at 500 roles and the saved cursor finishes the remainder", async () => {
  const t = convexTestWithComponents(schema, modules);
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Bounded Dealer", createdAt: 1 });
    for (let index = 0; index < 501; index += 1) {
      await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["create:sales"] });
    }
  });
  const first = await t.mutation(backfill, { numItems: 10_000 });
  expect(first.updatedCount).toBe(500);
  expect(first.isDone).toBe(false);
  const last = await t.mutation(backfill, { numItems: 0, cursor: first.continueCursor });
  expect(last.updatedCount).toBe(1);
  expect(last.isDone).toBe(true);
});
