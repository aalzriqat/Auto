import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { seedOrgWithMember } from "../test-utils/seedOrg";

async function verifyBudget(table: "orgLeadSources" | "orgCustomerStatuses",
  query: typeof api.orgLeadSources.listForLeads | typeof api.orgCustomerStatuses.listForQuotes) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, identity: reader } = await seedOrgWithMember(t, {
    clerkId: "bounded-choice-reader", orgName: "Synthetic configuration budget",
    permissions: ["view:org", "view:leads", "view:sales"],
  });
  const finalId = await t.run(async ctx => {
    // 8192 is Convex's published maximum array length. The final active row
    // makes silent truncation distinguishable from the complete old response.
    for (let index = 0; index < 8191; index++) {
      await ctx.db.insert(table, { orgId, label: `Synthetic choice ${index}`, isActive: false, order: index });
    }
    return ctx.db.insert(table, { orgId, label: "Synthetic final active choice", isActive: true, order: 8191 });
  });
  expect(await reader.query(query, { orgId })).toEqual([{ _id: finalId, label: "Synthetic final active choice" }]);
  await t.run(ctx => ctx.db.insert(table, { orgId, label: "Synthetic overflow row", isActive: false, order: 8192 }));
  await expect(reader.query(query, { orgId })).rejects.toMatchObject({ data: { code: "CONFIG_CHOICE_LIMIT" } });
}

// Literal entry points bind the two permanent regression-library records.
test("lead choices retain boundary values and refuse an oversized configuration", async () => {
  await verifyBudget("orgLeadSources", api.orgLeadSources.listForLeads);
});
test("quote choices retain boundary values and refuse an oversized configuration", async () => {
  await verifyBudget("orgCustomerStatuses", api.orgCustomerStatuses.listForQuotes);
});
