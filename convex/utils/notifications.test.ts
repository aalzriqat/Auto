import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "../schema";
import { notifyUser, notifyManagers, notifyAllMembers, notifyOwner } from "./notifications";

vi.mock("../rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() }));

  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["manage:users"], isSystemOwnerRole: true })
  );
  const managerRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] }));
  const salesRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] }));

  const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "owner_001", email: "owner@test.com" }));
  const managerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "manager_001", email: "manager@test.com" }));
  const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "sales_001", email: "sales@test.com" }));

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRoleId }));

  return { orgId, ownerId, managerId, salesId };
}

describe("dispatch helpers", () => {
  test("notifyUser inserts an in-app row with the type's category/priority", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "lead.assigned", { actorName: "Alice" }, { link: "/leads" }));

    const rows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("lead.assigned");
    expect(rows[0].category).toBe("sales");
    expect(rows[0].priority).toBe("normal");
    expect(rows[0].data).toEqual({ actorName: "Alice" });
    expect(rows[0].link).toBe("/leads");
  });

  test("notifyManagers fans out only to members holding MANAGE_USERS, honoring excludeUserId", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Bob" }, { excludeUserId: ownerId }));

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const managerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect());
    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());

    expect(ownerRows).toHaveLength(0); // excluded
    expect(managerRows).toHaveLength(1); // holds MANAGE_USERS
    expect(salesRows).toHaveLength(0); // no MANAGE_USERS permission
  });

  test("notifyAllMembers fans out to every member of the org", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyAllMembers(ctx, orgId, "system.announcement", { title: "Heads up", message: "Maintenance tonight" }));

    for (const userId of [ownerId, managerId, salesId]) {
      const rows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toEqual({ title: "Heads up", message: "Maintenance tonight" });
    }
  });

  test("notifyOwner notifies only the OWNER role", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyOwner(ctx, orgId, "role.changed", { actorName: "Carol", roleName: "SALES" }));

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const managerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect());
    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());

    expect(ownerRows).toHaveLength(1);
    expect(managerRows).toHaveLength(0);
    expect(salesRows).toHaveLength(0);
  });

  test("email defaults to the type's criticalDefault when no preference row exists", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));

    // "approval.requested" has criticalDefault: true -> should schedule an email with no preference row set.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduledAfterCritical = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduledAfterCritical.length).toBeGreaterThan(0);
  });

  test("email is not scheduled when the user has explicitly opted out of a category", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "finance",
        emailEnabled: false,
        whatsappEnabled: false,
      })
    );

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("push is not scheduled by default even when email is (opt-in only, unlike email)", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);

    // "approval.requested" has criticalDefault: true, so email schedules with no
    // preference row set — but push has no criticalDefault fallback, so the total
    // scheduled count should be exactly 1 (email only), not 2.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("push is scheduled once the user opts a category into pushEnabled", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: false,
        pushEnabled: true,
      })
    );

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created", { actorName: "Dana" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });
});
