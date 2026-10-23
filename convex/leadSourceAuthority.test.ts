import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

test("Reception receives active own lead sources while settings remains refused", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const template = DEFAULT_ROLE_TEMPLATES.find(role => role.name === "RECEPTION");
  if (!template) throw new Error("Missing actual Reception template");
  const { orgId, foreignOrgId, roleId, sourceId } = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic source dealer", createdAt: Date.now() });
    const foreignOrgId = await ctx.db.insert("organizations", { name: "Synthetic foreign dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "lead-source-reader", email: "reader@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: template.name, permissions: [...template.permissions] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const sourceId = await ctx.db.insert("orgLeadSources", { orgId, label: "Synthetic configured channel", isActive: true, order: 1 });
    await ctx.db.insert("orgLeadSources", { orgId, label: "Synthetic retired", isActive: false, order: 0 });
    await ctx.db.insert("orgLeadSources", { orgId: foreignOrgId, label: "Synthetic foreign", isActive: true, order: 0 });
    return { orgId, foreignOrgId, roleId, sourceId };
  });
  const reception = t.withIdentity({ subject: "lead-source-reader" });
  await expect(reception.query(api.orgLeadSources.list, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  expect(await reception.query(api.orgLeadSources.listForLeads, { orgId })).toEqual([{ _id: sourceId, label: "Synthetic configured channel" }]);
  await expect(reception.query(api.orgLeadSources.listForLeads, { orgId: foreignOrgId })).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  await expect(t.query(api.orgLeadSources.listForLeads, { orgId })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  await t.run(ctx => ctx.db.patch(roleId, { permissions: ["view:org"] }));
  await expect(reception.query(api.orgLeadSources.listForLeads, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

test("Lead source projection distinguishes unconfigured from all disabled", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic unconfigured dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "source-empty-reader", email: "empty@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "Synthetic lead reader", permissions: ["view:org", "view:leads"] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    return orgId;
  });
  const reader = t.withIdentity({ subject: "source-empty-reader" });
  expect(await reader.query(api.orgLeadSources.listForLeads, { orgId })).toBeNull();
  await t.run(ctx => ctx.db.insert("orgLeadSources", { orgId, label: "Synthetic disabled channel", isActive: false, order: 0 }));
  expect(await reader.query(api.orgLeadSources.listForLeads, { orgId })).toEqual([]);
  await expect(t.query(api.orgLeadSources.listForLeads, { orgId }))
    .rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});
