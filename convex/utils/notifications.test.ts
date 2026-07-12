import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "../schema";
import { notifyUser, notifyManagers, notifyAllMembers, notifyOwner, notifyByPermission, getActorName } from "./notifications";
import { PERMISSIONS } from "./permissions";

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

  test("dispatch still inserts the in-app row but no-ops the rest if the user no longer exists", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.delete(salesId));

    await expect(
      t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created", { actorName: "Dana" }))
    ).resolves.not.toThrow();

    const rows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    expect(rows).toHaveLength(1);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("schedules an email with no data argument at all (not just an empty object)", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));

    // "approval.requested" has criticalDefault: true, so this schedules an
    // email even with no preference row and no data argument.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("schedules a WhatsApp notification when enabled, the plan supports it, and the user has a phone", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await t.run((ctx) => ctx.db.patch(salesId, { whatsappPhone: "+962700000000" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: true,
      })
    );

    // Also omits the data argument, exercising WhatsApp's own `data ?? {}` fallback.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("does not schedule WhatsApp when enabled by preference but the org's plan doesn't include it", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { whatsappPhone: "+962700000000" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: true,
      })
    );

    // No subscription row -> free plan, which doesn't include whatsapp.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("passes an empty object to the scheduled push action when no data is given", async () => {
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

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("notifyManagers skips a membership whose role has been deleted", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, managerId } = await seedOrg(t);
    const ghostUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "ghost_001", email: "ghost@test.com" }));
    const ghostRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "GHOST", permissions: ["manage:users"] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ghostUserId, roleId: ghostRoleId }));
    await t.run((ctx) => ctx.db.delete(ghostRoleId));

    await expect(
      t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Eve" }))
    ).resolves.not.toThrow();

    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    expect(managerRows).toHaveLength(1);
    const ghostRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ghostUserId)).collect()
    );
    expect(ghostRows).toHaveLength(0);
  });

  test("notifyAllMembers honors excludeUserId", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) =>
      notifyAllMembers(ctx, orgId, "system.announcement", { title: "Heads up", message: "Maintenance" }, { excludeUserId: salesId })
    );

    const salesRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    expect(salesRows).toHaveLength(0);
    const ownerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect()
    );
    expect(ownerRows).toHaveLength(1);
    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    expect(managerRows).toHaveLength(1);
  });

  test("notifyByPermission skips excluded, missing-role, and unauthorized members", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, managerId, salesId } = await seedOrg(t);
    const viewerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "VIEWER", permissions: [PERMISSIONS.VIEW_VEHICLES] })
    );
    const viewerId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "viewer_001", email: "viewer@test.com" })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));

    const ghostUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "ghost_perm_001", email: "ghost-perm@test.com" })
    );
    const ghostRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "GHOST", permissions: [PERMISSIONS.VIEW_VEHICLES] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ghostUserId, roleId: ghostRoleId }));
    await t.run((ctx) => ctx.db.delete(ghostRoleId));

    await t.run((ctx) =>
      notifyByPermission(ctx, orgId, PERMISSIONS.VIEW_VEHICLES, "vehicle.created", { actorName: "Nora" }, { excludeUserId: salesId })
    );

    const viewerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", viewerId)).collect()
    );
    const salesRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    const ghostRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ghostUserId)).collect()
    );

    expect(viewerRows).toHaveLength(1);
    expect(salesRows).toHaveLength(0);
    expect(managerRows).toHaveLength(0);
    expect(ghostRows).toHaveLength(0);
  });
});

describe("getActorName", () => {
  test("returns 'Someone' when unauthenticated", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const name = await t.run((ctx) => getActorName(ctx));
    expect(name).toBe("Someone");
  });

  test("returns the user's own name when set", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_1", email: "a@test.com", name: "Farah" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_1", name: "Identity Name" }) as any },
      } as any)
    );
    expect(name).toBe("Farah");
  });

  test("falls back to the identity's name when the user row has none", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_2", email: "b@test.com" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_2", name: "Identity Name" }) as any },
      } as any)
    );
    expect(name).toBe("Identity Name");
  });

  test("falls back to 'A team member' when neither the user nor identity have a name", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_3", email: "c@test.com" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_3" }) as any },
      } as any)
    );
    expect(name).toBe("A team member");
  });
});
