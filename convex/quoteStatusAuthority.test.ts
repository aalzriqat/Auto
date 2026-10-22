import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

async function setup(roleName = "ACCOUNTANT") {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const role = DEFAULT_ROLE_TEMPLATES.find(item => item.name === roleName);
  if (!role) throw new Error("Missing actual role template");
  const rows = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic quote dealer", createdAt: Date.now() });
    const foreignOrgId = await ctx.db.insert("organizations", { name: "Synthetic foreign dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "quote-status-reader", email: "reader@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: role.name, permissions: [...role.permissions] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const second = await ctx.db.insert("orgCustomerStatuses", { orgId, label: "Synthetic second", isActive: true, order: 2 });
    const first = await ctx.db.insert("orgCustomerStatuses", { orgId, label: "Synthetic first", isActive: true, order: 1 });
    await ctx.db.insert("orgCustomerStatuses", { orgId, label: "Synthetic retired", isActive: false, order: 0 });
    await ctx.db.insert("orgCustomerStatuses", { orgId: foreignOrgId, label: "Synthetic foreign", isActive: true, order: 0 });
    return { orgId, foreignOrgId, roleId, first, second };
  });
  return { t, ...rows, reader: t.withIdentity({ subject: "quote-status-reader" }) };
}

test("an accountant can read only active tenant quote choices without settings authority", async () => {
  const { reader, orgId, first, second } = await setup();
  await expect(reader.query(api.orgCustomerStatuses.list, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  expect(await reader.query(api.orgCustomerStatuses.listForQuotes, { orgId })).toEqual([
    { _id: first, label: "Synthetic first" }, { _id: second, label: "Synthetic second" },
  ]);
});

test("quote status choices refuse a caller without sales authority", async () => {
  const { reader, orgId } = await setup("RECEPTION");
  await expect(reader.query(api.orgCustomerStatuses.listForQuotes, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

test("quote status choices refuse a foreign tenant and unauthenticated caller", async () => {
  const { reader, t, orgId, foreignOrgId } = await setup();
  await expect(reader.query(api.orgCustomerStatuses.listForQuotes, { orgId: foreignOrgId })).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  await expect(t.query(api.orgCustomerStatuses.listForQuotes, { orgId })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("quote status choices recheck revoked sales authority", async () => {
  const { reader, t, orgId, roleId } = await setup();
  expect(await reader.query(api.orgCustomerStatuses.listForQuotes, { orgId })).toHaveLength(2);
  await t.run(ctx => ctx.db.patch(roleId, { permissions: ["view:org"] }));
  await expect(reader.query(api.orgCustomerStatuses.listForQuotes, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});
