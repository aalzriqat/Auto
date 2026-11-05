import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");

test("SCRUM-908: a newly seeded ACCOUNTANT sees commissions without commission-management authority", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "accountant_commissions_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Commission Template Dealer" });
  const accountant = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  expect(accountant).toBeDefined();
  if (!accountant) throw new Error("ACCOUNTANT was not seeded");
  expect(accountant.permissions).toContain(PERMISSIONS.VIEW_COMMISSIONS);
  expect(accountant.permissions).not.toContain(PERMISSIONS.MANAGE_COMMISSIONS);

  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId: "accountant_commissions_member", email: "accountant@example.test" });
    await ctx.db.insert("memberships", { orgId, userId, roleId: accountant._id });
  });
  const member = t.withIdentity({ subject: "accountant_commissions_member" });
  await expect(member.query(api.sales.listCommissions, { orgId })).resolves.toEqual([]);

  // Changing the template never replaces the backend membership boundary.
  const foreignOrgId = await owner.mutation(api.organizations.create, { name: "Foreign Commission Dealer" });
  await expect(member.query(api.sales.listCommissions, { orgId: foreignOrgId })).rejects.toThrow(/member|access|forbidden/i);
});

test("SCRUM-908: owner role saves accept commission visibility alongside accounting permissions", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "accountant_commissions_role_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Commission Role Dealer" });
  const permissions = ["view:finance", "manage:finance", "confirm:finance_disbursement", "view:cost_price", "view:commissions"];
  const roleId = await owner.mutation(api.roles.create, { orgId, name: "Commission Accountant", permissions });
  expect((await owner.query(api.roles.get, { orgId, roleId })).permissions).toEqual(permissions);
  await owner.mutation(api.roles.update, { orgId, roleId, name: "Saved Commission Accountant", permissions });
  expect((await owner.query(api.roles.get, { orgId, roleId })).permissions).toEqual(permissions);
});

test("SCRUM-908: an owner may restrict ACCOUNTANT commission visibility while retaining sale completion and cost access", async () => {
  const t = convexTestWithComponents(schema, modules);
  const owner = t.withIdentity({ subject: "accountant_commissions_restrict_owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "Restricted Commission Dealer" });
  const accountant = (await owner.query(api.roles.list, { orgId })).find((role) => role.name === "ACCOUNTANT");
  if (!accountant) throw new Error("ACCOUNTANT was not seeded");
  const restricted = accountant.permissions.filter((permission) => permission !== PERMISSIONS.VIEW_COMMISSIONS);
  await owner.mutation(api.roles.update, { orgId, roleId: accountant._id, permissions: restricted });
  const saved = await owner.query(api.roles.get, { orgId, roleId: accountant._id });
  expect(saved.permissions).toEqual(restricted);
  expect(saved.permissions).toContain(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  expect(saved.permissions).toContain(PERMISSIONS.VIEW_COST_PRICE);
  expect(saved.permissions).not.toContain(PERMISSIONS.VIEW_COMMISSIONS);
});
