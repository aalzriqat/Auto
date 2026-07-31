import { convexTestWithComponents } from "../../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import { Id } from "../_generated/dataModel";
import schema from "../schema";
import { nextGeneratedLeadAssignee, resolveGeneratedLeadAssignee } from "./leadAssignment";
import { PERMISSIONS } from "./permissions";

async function seedOrg(autoAssignEnabled: boolean) {
  const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Assignment Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "د.أ",
      enabledPaymentTypes: ["CASH"],
      generatedLeadAutoAssignmentEnabled: autoAssignEnabled,
    })
  );
  const salesRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads"] })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] })
  );

  return { t, orgId, salesRoleId, managerRoleId };
}

async function addMember(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  roleId: Id<"roles">,
  name: string,
  disabled = false
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${name.toLowerCase().replace(/\s+/g, "_")}_clerk`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      name,
      disabled,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return userId;
}

describe("generated lead assignment", () => {
  test("does nothing when the dealer toggle is off", async () => {
    const { t, orgId, salesRoleId } = await seedOrg(false);
    await addMember(t, orgId, salesRoleId, "Sales One");

    const assignee = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));
    const cursors = await t.run((ctx) => ctx.db.query("leadAssignmentCursors").collect());

    expect(assignee).toBeNull();
    expect(cursors).toHaveLength(0);
  });

  test("cycles active SALES members in membership order", async () => {
    const { t, orgId, salesRoleId, managerRoleId } = await seedOrg(true);
    const firstSalesId = await addMember(t, orgId, salesRoleId, "Sales One");
    await addMember(t, orgId, managerRoleId, "Manager One");
    const secondSalesId = await addMember(t, orgId, salesRoleId, "Sales Two");

    const first = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));
    const second = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));
    const third = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));

    expect(first).toBe(firstSalesId);
    expect(second).toBe(secondSalesId);
    expect(third).toBe(firstSalesId);
  });

  test("skips disabled sales members", async () => {
    const { t, orgId, salesRoleId } = await seedOrg(true);
    await addMember(t, orgId, salesRoleId, "Disabled Sales", true);
    const activeSalesId = await addMember(t, orgId, salesRoleId, "Active Sales");

    const assignee = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));

    expect(assignee).toBe(activeSalesId);
  });

  test("includes custom lead-handling roles without routing to managers", async () => {
    const { t, orgId } = await seedOrg(true);
    const managerLikeRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Sales Manager",
        permissions: [
          PERMISSIONS.VIEW_LEADS,
          PERMISSIONS.CREATE_LEADS,
          PERMISSIONS.EDIT_LEADS,
          PERMISSIONS.MANAGE_USERS,
        ],
      })
    );
    const customSalesRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Internet Sales",
        permissions: [
          PERMISSIONS.VIEW_LEADS,
          PERMISSIONS.CREATE_LEADS,
          PERMISSIONS.EDIT_LEADS,
        ],
      })
    );
    await addMember(t, orgId, managerLikeRoleId, "Manager Lead Admin");
    const customSalesId = await addMember(t, orgId, customSalesRoleId, "Custom Sales");

    const assignee = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));

    expect(assignee).toBe(customSalesId);
  });

  test("skips a sales member excluded from auto assignment", async () => {
    const { t, orgId, salesRoleId } = await seedOrg(true);
    const excludedId = await addMember(t, orgId, salesRoleId, "On Leave");
    const activeId = await addMember(t, orgId, salesRoleId, "Sales Two");

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", excludedId))
        .unique();
      await ctx.db.patch(membership!._id, { excludeFromLeadAutoAssignment: true });
    });

    // Two draws in a row: an excluded member must not surface on either.
    const first = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));
    const second = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));

    expect(first).toBe(activeId);
    expect(second).toBe(activeId);
  });

  test("excluding every sales member leaves generated leads unassigned", async () => {
    const { t, orgId, salesRoleId } = await seedOrg(true);
    const onlySalesId = await addMember(t, orgId, salesRoleId, "Sales One");

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", onlySalesId))
        .unique();
      await ctx.db.patch(membership!._id, { excludeFromLeadAutoAssignment: true });
    });

    const assignee = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));
    expect(assignee).toBeNull();
  });

  test("an explicit route still reaches an excluded member", async () => {
    // Exclusion removes someone from *automatic* distribution only — a manager
    // pointing the website form at them by hand is a deliberate choice.
    const { t, orgId, salesRoleId } = await seedOrg(true);
    const excludedId = await addMember(t, orgId, salesRoleId, "On Leave");
    await addMember(t, orgId, salesRoleId, "Sales Two");

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", excludedId))
        .unique();
      await ctx.db.patch(membership!._id, { excludeFromLeadAutoAssignment: true });
    });

    const explicit = await t.run((ctx) => resolveGeneratedLeadAssignee(ctx, orgId, excludedId));
    expect(explicit).toBe(excludedId);
  });

  test("keeps a valid explicit route without advancing the round-robin cursor", async () => {
    const { t, orgId, salesRoleId, managerRoleId } = await seedOrg(true);
    const routedUserId = await addMember(t, orgId, managerRoleId, "Routed Manager");
    const salesUserId = await addMember(t, orgId, salesRoleId, "Sales One");

    const explicit = await t.run((ctx) => resolveGeneratedLeadAssignee(ctx, orgId, routedUserId));
    const firstAuto = await t.run((ctx) => nextGeneratedLeadAssignee(ctx, orgId));

    expect(explicit).toBe(routedUserId);
    expect(firstAuto).toBe(salesUserId);
  });
});
