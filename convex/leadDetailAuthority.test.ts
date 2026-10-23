import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api } from "./_generated/api";

test("a lead-only reader gets its detail while unrelated edit catalogs remain refused", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, userId, identity: reader } = await seedOrgWithMember(t, {
    clerkId: "detail-reader", permissions: ["view:org", "view:leads"],
  });
  const leadId = await t.run(async ctx => {
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" });
    return ctx.db.insert("leads", { orgId, customerId, assignedUserId: userId, stage: "NEW", source: "Website" });
  });
  const lead = await reader.query(api.leads.get, { orgId, leadId });
  expect(lead).toMatchObject({ _id: leadId, customer: { firstName: "Synthetic", lastName: "Buyer" } });
  expect(await reader.query(api.leadActivities.listForLead, { orgId, leadId })).toEqual([]);
  await expect(reader.query(api.customers.selectorOptions, { orgId, search: "" }))
    .rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(reader.query(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true }))
    .rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(reader.query(api.memberships.list, { orgId, paginationOpts: { numItems: 100, cursor: null } }))
    .rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});
